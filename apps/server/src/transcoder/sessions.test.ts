import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import { setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { events, sessionRegistry, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { type HlsName, parseHlsName } from "../playback/playlists.ts";
import { deriveSegmentTimeline } from "../playback/timeline.ts";
import {
  createSessionManager,
  type SessionManager,
  type SessionScope,
} from "./sessions.ts";

HLS.setOptions({ strictMode: true });

const hlsName = (raw: string): HlsName => {
  const parsed = parseHlsName(raw);
  if (parsed === null) throw new Error(`Bad HLS name: ${raw}`);
  return parsed;
};

const pathExists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const probeStartTime = async (path: string) => {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=start_time",
      "-of",
      "json",
      "-i",
      path,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [output, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed (${exitCode}): ${stderr.trim()}`);
  }
  const parsed = JSON.parse(output) as { format?: { start_time?: string } };
  return Number(parsed.format?.start_time);
};

describe.skipIf(!databaseUrl)("session manager", () => {
  let libraryRoot: string;
  let scratchRoot: string;
  let duration: number;
  let boundaries: number[];

  beforeAll(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "pendia-hls-library-"));
    scratchRoot = await mkdtemp(join(tmpdir(), "pendia-hls-scratch-"));
    const folder = join(libraryRoot, "Movie (2026)");
    await mkdir(folder);
    const file = join(folder, "Movie.mkv");
    await createVideoFixture(file, {
      width: 1920,
      height: 1080,
      durationSeconds: 12,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
    });
    const probe = await probeVideo(file);
    if (probe.durationSeconds === null || probe.keyframesSeconds === null) {
      throw new Error("Fixture probe returned no duration or keyframes.");
    }
    duration = probe.durationSeconds;
    boundaries = deriveSegmentTimeline(probe.keyframesSeconds, duration);
    expect(boundaries.slice(0, 4)).toEqual([0, 3, 6, 9]);
  }, 60_000);

  afterAll(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(scratchRoot, { recursive: true, force: true });
  });

  const withSession = async (
    run: (context: {
      db: Database;
      manager: SessionManager;
      scope: SessionScope;
      scratchDir: string;
      itemId: string;
      versionId: string;
    }) => Promise<void>,
  ) => {
    await withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        rootPath: libraryRoot,
      });
      const scanned = await scanDirectory(db, library.id, "Movie (2026)");
      const versionId = scanned.versionIds[0];
      if (scanned.itemId === null || versionId === undefined) {
        throw new Error("Expected exactly one scanned item and version.");
      }
      const [session] = await db
        .insert(sessionRegistry)
        .values({
          userId: admin.id,
          itemId: scanned.itemId,
          versionId,
          playMethod: "remux",
          state: "starting",
        })
        .returning();
      if (session === undefined) {
        throw new Error("Session insert returned no row.");
      }
      const scratchDir = await mkdtemp(join(scratchRoot, "session-"));
      const manager = createSessionManager(db, {
        scratchDir,
        idleMs: 400,
        waitMs: 300,
        readRate: { rate: 1, initialBurstSeconds: 3.5 },
      });
      try {
        await run({
          db,
          manager,
          scope: {
            sessionId: session.id,
            itemId: scanned.itemId,
            versionId,
            userId: admin.id,
          },
          scratchDir,
          itemId: scanned.itemId,
          versionId,
        });
      } finally {
        await manager.stop();
      }
    });
  };

  test(
    "starts on the master request and serves the first segment",
    () =>
      withSession(async ({ manager, scope }) => {
        const startedAt = Date.now();
        const master = await manager.serve(
          scope,
          hlsName("master.m3u8"),
          "?token=t",
        );
        expect(master.status).toBe(200);
        expect(master.headers.get("content-type")).toBe(
          "application/vnd.apple.mpegurl",
        );
        const parsed = HLS.parse(await master.text());
        if (!parsed.isMasterPlaylist) {
          throw new Error("Expected a master playlist.");
        }
        expect(parsed.variants[0]?.uri).toBe("media.m3u8?token=t");
        const info = await manager.inspect(scope.sessionId);
        expect(info?.runs).toBe(1);
        expect(info?.running).toBe(true);

        const media = await manager.serve(
          scope,
          hlsName("media.m3u8"),
          "?token=t",
        );
        const mediaPlaylist = HLS.parse(await media.text());
        if (mediaPlaylist.isMasterPlaylist) {
          throw new Error("Expected a media playlist.");
        }
        expect(mediaPlaylist.segments.length).toBe(boundaries.length - 1);

        const init = await manager.serve(
          scope,
          hlsName("init.mp4"),
          "?token=t",
        );
        expect(init.status).toBe(200);
        expect(init.headers.get("content-type")).toBe("video/mp4");
        expect((await init.arrayBuffer()).byteLength).toBeGreaterThan(0);

        const segment = await manager.serve(
          scope,
          hlsName("0.m4s"),
          "?token=t",
        );
        expect(segment.status).toBe(200);
        expect(segment.headers.get("content-type")).toBe("video/iso.segment");
        expect((await segment.arrayBuffer()).byteLength).toBeGreaterThan(0);
        console.info(`first playable segment in ${Date.now() - startedAt} ms`);
      }),
    30_000,
  );

  test(
    "waits for the next segment and answers 503 on timeout",
    () =>
      withSession(async ({ manager, scope }) => {
        await manager.serve(scope, hlsName("master.m3u8"), "");
        // Segment 0 lands inside the initial burst; wait for it so the next
        // request takes the wait path instead of restarting.
        const first = await manager.serve(scope, hlsName("0.m4s"), "");
        expect(first.status).toBe(200);
        const waitedAt = Date.now();
        const pending = await manager.serve(scope, hlsName("1.m4s"), "");
        expect(pending.status).toBe(503);
        expect(pending.headers.get("retry-after")).toBe("1");
        expect(Date.now() - waitedAt).toBeLessThan(300 + 200);
        const deadline = Date.now() + 5_000;
        let status = 0;
        while (Date.now() < deadline) {
          const response = await manager.serve(scope, hlsName("1.m4s"), "");
          status = response.status;
          if (status === 200) break;
          await Bun.sleep(100);
        }
        expect(status).toBe(200);
      }),
    30_000,
  );

  test(
    "a seek restarts ffmpeg and cached segments do not",
    () =>
      withSession(async ({ manager, scope, scratchDir }) => {
        await manager.serve(scope, hlsName("master.m3u8"), "");
        // Segment 0 lands inside the first run's initial burst, so it is in
        // scratch before the seek kills that run.
        const cached = await manager.serve(scope, hlsName("0.m4s"), "");
        expect(cached.status).toBe(200);
        const seekAt = Date.now();
        const seeked = await manager.serve(scope, hlsName("3.m4s"), "");
        const seekElapsed = Date.now() - seekAt;
        expect(seeked.status).toBe(200);
        expect(seekElapsed).toBeLessThan(2_000);
        console.info(`seek served in ${seekElapsed} ms`);
        const info = await manager.inspect(scope.sessionId);
        expect(info?.runs).toBe(2);

        const init = await manager.serve(scope, hlsName("init.mp4"), "");
        expect(init.status).toBe(200);
        const joined = join(scratchDir, "seeked.mp4");
        await writeFile(
          joined,
          Buffer.concat([
            Buffer.from(await init.arrayBuffer()),
            Buffer.from(await seeked.arrayBuffer()),
          ]),
        );
        expect(await probeStartTime(joined)).toBeCloseTo(9, 1);

        const again = await manager.serve(scope, hlsName("0.m4s"), "");
        expect(again.status).toBe(200);
        expect((await manager.inspect(scope.sessionId))?.runs).toBe(2);
      }),
    30_000,
  );

  test(
    "idle stop deletes scratch and a later request revives",
    () =>
      withSession(async ({ db, manager, scope, scratchDir }) => {
        await manager.serve(scope, hlsName("master.m3u8"), "");
        const first = await manager.serve(scope, hlsName("0.m4s"), "");
        expect(first.status).toBe(200);
        await Bun.sleep(900);
        expect(await manager.inspect(scope.sessionId)).toBeUndefined();
        expect(await pathExists(join(scratchDir, scope.sessionId))).toBe(false);

        const revived = await manager.serve(scope, hlsName("2.m4s"), "");
        expect(revived.status).toBe(200);
        expect(await pathExists(join(scratchDir, scope.sessionId))).toBe(true);
        const [row] = await db
          .select({ state: sessionRegistry.state })
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, scope.sessionId))
          .limit(1);
        expect(row?.state).toBe("starting");
      }),
    30_000,
  );

  test(
    "publishes segment.ready events",
    () =>
      withSession(async ({ db, manager, scope }) => {
        await manager.serve(scope, hlsName("master.m3u8"), "");
        await manager.serve(scope, hlsName("0.m4s"), "");
        const deadline = Date.now() + 3_000;
        let matching: number[] = [];
        while (Date.now() < deadline) {
          const rows = await db
            .select()
            .from(events)
            .where(eq(events.kind, "segment.ready"));
          matching = rows
            .map((row) => row.payload)
            .filter(
              (payload) =>
                payload.sessionId === scope.sessionId &&
                Number.isInteger(payload.index),
            )
            .map((payload) => Number(payload.index));
          if (matching.length > 0) break;
          await Bun.sleep(50);
        }
        expect(matching).toContain(0);
      }),
    30_000,
  );

  test(
    "refuses a version without an aligned timeline",
    () =>
      withSession(async ({ db, manager, scope, versionId }) => {
        await db
          .update(versions)
          .set({ timelineAligned: false })
          .where(eq(versions.id, versionId));
        const failure = await manager
          .serve(scope, hlsName("master.m3u8"), "")
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(failure).toBeInstanceOf(AuthError);
        expect((failure as AuthError).code).toBe("CONFLICT");
      }),
    30_000,
  );

  test(
    "stop kills runs and removes scratch",
    () =>
      withSession(async ({ manager, scope, scratchDir }) => {
        await manager.serve(scope, hlsName("master.m3u8"), "");
        const pid = (await manager.inspect(scope.sessionId))?.pid;
        expect(typeof pid).toBe("number");
        await manager.stop();
        expect(await manager.inspect(scope.sessionId)).toBeUndefined();
        expect(await pathExists(join(scratchDir, scope.sessionId))).toBe(false);
        if (pid === null || pid === undefined) {
          throw new Error("Expected a running ffmpeg pid.");
        }
        expect(() => process.kill(pid, 0)).toThrow();
      }),
    30_000,
  );
});
