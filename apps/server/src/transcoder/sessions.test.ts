import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import { setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  events,
  segmentTimelines,
  sessionRegistry,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import {
  decidePlayback,
  type PlaybackDecision,
} from "../playback/decisions.ts";
import { loadPlaybackSource } from "../playback/planning.ts";
import { type HlsName, parseHlsName } from "../playback/playlists.ts";
import { deriveSegmentTimeline } from "../playback/timeline.ts";
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerOptions,
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
    libraryRoot = await mkdtemp(join(tmpdir(), "thalia-hls-library-"));
    scratchRoot = await mkdtemp(join(tmpdir(), "thalia-hls-scratch-"));
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
    const { keyframesSeconds } = await readKeyframeIndex(file);
    if (probe.durationSeconds === null || keyframesSeconds === null) {
      throw new Error("Fixture probe returned no duration or keyframes.");
    }
    duration = probe.durationSeconds;
    boundaries = deriveSegmentTimeline(keyframesSeconds, duration);
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
    managerOptions: Partial<SessionManagerOptions> = {},
    decision?: PlaybackDecision,
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
        roots: [libraryRoot],
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
          ...(decision === undefined ? {} : { decision }),
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
        ...managerOptions,
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
      withSession(async ({ db, manager, scope }) => {
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
        const { source } = await loadPlaybackSource(
          db,
          scope.userId,
          scope.itemId,
          scope.versionId,
        );
        const variant = parsed.variants[0];
        expect(variant?.bandwidth).toBeGreaterThanOrEqual(
          Math.round(source.video.bitrate),
        );
        expect(variant?.bandwidth).toBe(
          Math.round(source.video.bitrate + (source.audio[0]?.bitrate ?? 0)),
        );
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

  /** Turns the scope's session into a 720p transcode and opens `extra` more like it for the same user. */
  const transcodeSessions = async (
    db: Database,
    scope: SessionScope,
    extra: number,
  ) => {
    const { source } = await loadPlaybackSource(
      db,
      scope.userId,
      scope.itemId,
      scope.versionId,
    );
    const decision = decidePlayback(
      source,
      {
        containers: ["mp4"],
        videoCodecs: [{ codec: "h264", maxWidth: 1280, maxHeight: 720 }],
        audioCodecs: [{ codec: "aac", maxChannels: 2 }],
        subtitleFormats: ["webvtt"],
        hdr: ["sdr"],
      },
      { isLan: true },
    );
    await db
      .update(sessionRegistry)
      .set({ playMethod: "transcode", decision })
      .where(eq(sessionRegistry.id, scope.sessionId));
    const scopes = [scope];
    for (let added = 0; added < extra; added++) {
      const [row] = await db
        .insert(sessionRegistry)
        .values({
          userId: scope.userId,
          itemId: scope.itemId,
          versionId: scope.versionId,
          playMethod: "transcode",
          state: "starting",
          decision,
        })
        .returning({ id: sessionRegistry.id });
      if (row === undefined) throw new Error("Session insert returned no row.");
      scopes.push({ ...scope, sessionId: row.id });
    }
    return scopes;
  };

  const registryState = async (db: Database, sessionId: string) => {
    const [row] = await db
      .select({ state: sessionRegistry.state })
      .from(sessionRegistry)
      .where(eq(sessionRegistry.id, sessionId));
    return row?.state;
  };

  const stateEvents = async (db: Database, sessionId: string) =>
    (
      await db
        .select({ payload: events.payload })
        .from(events)
        .orderBy(asc(events.id))
    )
      .map(({ payload }) => payload)
      .filter(
        (payload) =>
          payload.kind === "session.state" && payload.sessionId === sessionId,
      )
      .map((payload) => payload.state);

  test(
    "a third transcode session queues and starts when one ends",
    () =>
      withSession(
        async ({ db, manager, scope }) => {
          const [first, second, third] = await transcodeSessions(db, scope, 2);
          if (!first || !second || !third) throw new Error("Expected three.");
          for (const running of [first, second]) {
            await manager.serve(running, hlsName("master.m3u8"), "");
            expect(
              (await manager.serve(running, hlsName("0.m4s"), "")).status,
            ).toBe(200);
          }

          // The third still gets its playlists, but no ffmpeg and a queued state.
          const master = await manager.serve(third, hlsName("master.m3u8"), "");
          expect(master.status).toBe(200);
          expect(await manager.inspect(third.sessionId)).toMatchObject({
            queued: true,
            runs: 0,
          });
          const queuedDeadline = Date.now() + 2_000;
          while ((await registryState(db, third.sessionId)) !== "queued") {
            if (Date.now() > queuedDeadline) throw new Error("Not queued.");
            await Bun.sleep(20);
          }
          expect(await stateEvents(db, third.sessionId)).toEqual(["queued"]);

          const waiting = manager.serve(third, hlsName("0.m4s"), "");
          await Bun.sleep(200);
          expect((await manager.inspect(third.sessionId))?.runs).toBe(0);
          await manager.end(first.sessionId);
          expect(await manager.inspect(first.sessionId)).toBeUndefined();
          const segment = await waiting;
          expect(segment.status).toBe(200);
          expect(await manager.inspect(third.sessionId)).toMatchObject({
            queued: false,
            runs: 1,
          });
          const startedDeadline = Date.now() + 2_000;
          while ((await registryState(db, third.sessionId)) !== "starting") {
            if (Date.now() > startedDeadline) throw new Error("Not started.");
            await Bun.sleep(20);
          }
          expect(await stateEvents(db, third.sessionId)).toEqual([
            "queued",
            "starting",
          ]);
        },
        // An encode outlasts the remux tests' short idle and wait limits.
        {
          idleMs: 30_000,
          waitMs: 10_000,
          readRate: undefined,
          transcodeSlots: 2,
        },
      ),
    60_000,
  );

  test(
    "a queued session that idled out revives into a free slot as starting",
    () =>
      withSession(
        async ({ db, manager, scope }) => {
          const [first, second] = await transcodeSessions(db, scope, 1);
          if (!first || !second) throw new Error("Expected two.");
          await manager.serve(first, hlsName("master.m3u8"), "");
          await manager.serve(second, hlsName("master.m3u8"), "");
          const until = async (
            check: () => Promise<boolean>,
            message: string,
          ) => {
            const deadline = Date.now() + 3_000;
            while (!(await check())) {
              if (Date.now() > deadline) throw new Error(message);
              await Bun.sleep(20);
            }
          };
          await until(
            async () =>
              (await registryState(db, second.sessionId)) === "queued",
            "Not queued.",
          );
          // Keep the first alive while the queued second idles out.
          await Bun.sleep(500);
          await manager.serve(first, hlsName("master.m3u8"), "");
          await until(
            async () => (await manager.inspect(second.sessionId)) === undefined,
            "The queued session never idled out.",
          );
          expect(await registryState(db, second.sessionId)).toBe("queued");

          await manager.end(first.sessionId);
          await manager.serve(second, hlsName("master.m3u8"), "");
          expect(await manager.inspect(second.sessionId)).toMatchObject({
            queued: false,
            runs: 1,
          });
          await until(
            async () =>
              (await registryState(db, second.sessionId)) === "starting",
            "The revived session still reads queued.",
          );
          expect(await stateEvents(db, second.sessionId)).toEqual([
            "queued",
            "starting",
          ]);
        },
        {
          idleMs: 1_000,
          waitMs: 10_000,
          readRate: undefined,
          transcodeSlots: 1,
        },
      ),
    30_000,
  );

  test("concurrent first requests for a subtitle share one conversion", () =>
    withSession(async ({ manager, scope }) => {
      const responses = await Promise.all(
        [0, 1, 2].map(() => manager.serve(scope, hlsName("subs-0.vtt"), "")),
      );
      const texts = await Promise.all(
        responses.map(async (response) => {
          expect(response.status).toBe(200);
          return response.text();
        }),
      );
      expect(texts[0]).toContain("Fixture");
      expect(new Set(texts).size).toBe(1);
    }));

  test(
    "a queued request answers 503 SESSION_QUEUED after the wait, and remux never queues",
    () =>
      withSession(
        async ({ db, manager, scope }) => {
          const [first, second] = await transcodeSessions(db, scope, 1);
          if (!first || !second) throw new Error("Expected two.");
          await manager.serve(first, hlsName("master.m3u8"), "");
          await manager.serve(second, hlsName("master.m3u8"), "");
          const waitedAt = Date.now();
          const queued = await manager.serve(second, hlsName("init.mp4"), "");
          expect(Date.now() - waitedAt).toBeGreaterThanOrEqual(250);
          expect(queued.status).toBe(503);
          expect(queued.headers.get("retry-after")).toBe("1");
          expect(await queued.json()).toMatchObject({
            error: { code: "SESSION_QUEUED" },
          });

          // A remux session with the only slot taken still starts at once.
          const [remux] = await db
            .insert(sessionRegistry)
            .values({
              userId: scope.userId,
              itemId: scope.itemId,
              versionId: scope.versionId,
              playMethod: "remux",
              state: "starting",
            })
            .returning({ id: sessionRegistry.id });
          if (remux === undefined) throw new Error("No remux session.");
          const remuxScope = { ...scope, sessionId: remux.id };
          await manager.serve(remuxScope, hlsName("master.m3u8"), "");
          expect(await manager.inspect(remux.id)).toMatchObject({
            queued: false,
            runs: 1,
          });
        },
        { transcodeSlots: 1 },
      ),
    30_000,
  );

  test(
    "a transcode session encodes the rung and offers the SRT as WebVTT",
    () =>
      withSession(
        async ({ db, manager, scope, scratchDir }) => {
          const { source } = await loadPlaybackSource(
            db,
            scope.userId,
            scope.itemId,
            scope.versionId,
          );
          // The client decodes H.264 up to 720p only, so the 1080p source re-encodes.
          const decision = decidePlayback(
            source,
            {
              containers: ["mp4"],
              videoCodecs: [{ codec: "h264", maxWidth: 1280, maxHeight: 720 }],
              audioCodecs: [{ codec: "aac", maxChannels: 2 }],
              subtitleFormats: ["webvtt"],
              hdr: ["sdr"],
            },
            { isLan: true },
          );
          expect(decision.method).toBe("transcode");
          await db
            .update(sessionRegistry)
            .set({ playMethod: "transcode", decision })
            .where(eq(sessionRegistry.id, scope.sessionId));

          const master = HLS.parse(
            await (
              await manager.serve(scope, hlsName("master.m3u8"), "?token=t")
            ).text(),
          );
          if (!master.isMasterPlaylist) {
            throw new Error("Expected a master playlist.");
          }
          const variant = master.variants[0];
          expect(variant?.resolution).toEqual({ width: 1280, height: 720 });
          expect(variant?.subtitles).toMatchObject([
            {
              uri: "subs-0.m3u8?token=t",
              language: "nld",
              forced: true,
            },
          ]);
          expect((await manager.inspect(scope.sessionId))?.video).toBe(
            "transcode",
          );

          const init = await manager.serve(scope, hlsName("init.mp4"), "");
          const segment = await manager.serve(scope, hlsName("0.m4s"), "");
          expect(segment.status).toBe(200);
          const joined = join(scratchDir, "transcoded.mp4");
          await writeFile(
            joined,
            Buffer.concat([
              Buffer.from(await init.arrayBuffer()),
              Buffer.from(await segment.arrayBuffer()),
            ]),
          );
          const probe = await probeVideo(joined);
          expect(
            probe.streams.find((stream) => stream.kind === "video"),
          ).toMatchObject({ codec: "h264", width: 1280, height: 720 });

          const subtitles = HLS.parse(
            await (
              await manager.serve(scope, hlsName("subs-0.m3u8"), "?token=t")
            ).text(),
          );
          if (subtitles.isMasterPlaylist) {
            throw new Error("Expected a media playlist.");
          }
          expect(subtitles.segments.map((entry) => entry.uri)).toEqual([
            "subs-0.vtt?token=t",
          ]);
          const vtt = await manager.serve(scope, hlsName("subs-0.vtt"), "");
          expect(vtt.status).toBe(200);
          expect(vtt.headers.get("content-type")).toBe("text/vtt");
          const text = await vtt.text();
          expect(text.startsWith("WEBVTT")).toBe(true);
          expect(text).toContain("00:00.000 --> 00:00.800");
          expect(
            (await manager.serve(scope, hlsName("subs-1.vtt"), "")).status,
          ).toBe(404);
        },
        // An encode outlasts the remux tests' short idle and wait limits.
        { idleMs: 30_000, waitMs: 10_000, readRate: undefined },
      ),
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
    "a seek answers the waiter it leaves behind at once",
    () =>
      withSession(
        async ({ manager, scope }) => {
          await manager.serve(scope, hlsName("master.m3u8"), "");
          const first = await manager.serve(scope, hlsName("0.m4s"), "");
          expect(first.status).toBe(200);
          // Segment 1 is inside the look-ahead, so this request parks on a
          // waiter that the seek to segment 3 leaves behind.
          let answeredAt = 0;
          const pending = manager
            .serve(scope, hlsName("1.m4s"), "")
            .then((response) => {
              answeredAt = Date.now();
              return response;
            });
          const seekAt = Date.now();
          const seeked = await manager.serve(scope, hlsName("3.m4s"), "");
          expect(seeked.status).toBe(200);
          const response = await pending;
          expect(response.status).toBe(503);
          const body = (await response.json()) as {
            error?: { code?: string };
          };
          expect(body.error?.code).toBe("SEGMENT_NOT_READY");
          expect(answeredAt - seekAt).toBeLessThan(1_000);
          expect((await manager.inspect(scope.sessionId))?.runs).toBe(2);
        },
        // Keep idle cleanup from answering the waiter before the seek can.
        { waitMs: 5_000, idleMs: 10_000 },
      ),
    30_000,
  );

  test(
    "parallel requests after a seek restart once and both are served",
    () =>
      withSession(
        async ({ manager, scope }) => {
          await manager.serve(scope, hlsName("master.m3u8"), "");
          // Both decisions are taken against the initial run; the second
          // must not kill the restart the first one queued.
          const [second, third] = await Promise.all([
            manager.serve(scope, hlsName("2.m4s"), ""),
            manager.serve(scope, hlsName("3.m4s"), ""),
          ]);
          expect(second.status).toBe(200);
          expect(third.status).toBe(200);
          expect((await manager.inspect(scope.sessionId))?.runs).toBe(2);
        },
        // The last segment lands after the throttle; keep idle and wait clear of it.
        { waitMs: 5_000, idleMs: 10_000 },
      ),
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
    "carries the Dolby Vision strip decision into the session",
    () =>
      withSession(
        async ({ db, manager, scope }) => {
          // The h264 fixture makes the dovi bitstream filter fail, so only
          // the master is requested; the flag itself is what is asserted.
          // The run's run.failed log is expected and silenced.
          const quiet = spyOn(console, "error").mockImplementation(() => {});
          try {
            await manager.serve(scope, hlsName("master.m3u8"), "");
            expect(
              (await manager.inspect(scope.sessionId))?.stripDolbyVision,
            ).toBe(true);

            const [second] = await db
              .insert(sessionRegistry)
              .values({
                userId: scope.userId,
                itemId: scope.itemId,
                versionId: scope.versionId,
                playMethod: "remux",
                state: "starting",
              })
              .returning();
            if (second === undefined) {
              throw new Error("Session insert returned no row.");
            }
            const secondScope = { ...scope, sessionId: second.id };
            await manager.serve(secondScope, hlsName("master.m3u8"), "");
            expect((await manager.inspect(second.id))?.stripDolbyVision).toBe(
              false,
            );
          } finally {
            await manager.stop();
            quiet.mockRestore();
          }
        },
        {},
        {
          method: "remux",
          video: {
            action: "copy",
            codec: "h264",
            hdr: "sdr",
            stripDolbyVision: true,
          },
          audio: null,
          subtitles: [],
          selection: { audio: null },
        },
      ),
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
    "a timeline past the media's end does not mark missing segments ready",
    () =>
      withSession(
        async ({ db, manager, scope, versionId }) => {
          // Boundaries are immutable, so a timeline one segment past the
          // media's end needs a new row; alignment must clear to repoint.
          const last = boundaries.at(-1);
          if (last === undefined) {
            throw new Error("Expected timeline boundaries.");
          }
          const [inserted] = await db
            .insert(segmentTimelines)
            .values({
              itemId: scope.itemId,
              cutKey: "extended",
              boundariesSeconds: [...boundaries, last + 3],
            })
            .returning({ id: segmentTimelines.id });
          if (inserted === undefined) {
            throw new Error("Timeline insertion returned no row.");
          }
          await db
            .update(versions)
            .set({ segmentTimelineId: inserted.id, timelineAligned: false })
            .where(eq(versions.id, versionId));
          await db
            .update(versions)
            .set({ timelineAligned: true })
            .where(eq(versions.id, versionId));

          const master = await manager.serve(scope, hlsName("master.m3u8"), "");
          expect(master.status).toBe(200);
          const first = await manager.serve(scope, hlsName("0.m4s"), "");
          expect(first.status).toBe(200);
          // The run is throttled: request 4 while the frontier sits at 2 so
          // it parks on a waiter. The run writes 0-3 and never 4, so the run's
          // end must reject the waiter instead of resolving it.
          const deadline = Date.now() + 20_000;
          let info = await manager.inspect(scope.sessionId);
          while (
            Date.now() < deadline &&
            !(info?.running === true && info.ready.includes(2))
          ) {
            await Bun.sleep(100);
            info = await manager.inspect(scope.sessionId);
          }
          if (info?.running !== true || !info.ready.includes(2)) {
            throw new Error("The run ended before the frontier reached 2.");
          }
          const pending = manager.serve(scope, hlsName("4.m4s"), "");
          while (Date.now() < deadline && info.running) {
            await Bun.sleep(100);
            info = await manager.inspect(scope.sessionId);
            if (info === undefined) break;
          }
          expect(info?.running).toBe(false);
          expect(info?.ready).toEqual([0, 1, 2, 3]);

          const missing = await pending;
          expect(missing.status).toBe(503);
          const body = (await missing.json()) as {
            error?: { code?: string };
          };
          expect(body.error?.code).toBe("SEGMENT_NOT_READY");
        },
        { idleMs: 20_000, waitMs: 20_000 },
      ),
    30_000,
  );

  test(
    "a failed run start does not poison later requests",
    () =>
      withSession(async ({ manager, scope, scratchDir }) => {
        // A regular file where the session directory must go fails mkdir.
        const blocker = join(scratchDir, scope.sessionId);
        await writeFile(blocker, "blocked");
        await expect(
          manager.serve(scope, hlsName("master.m3u8"), ""),
        ).rejects.toThrow();
        await rm(blocker);
        const master = await manager.serve(scope, hlsName("master.m3u8"), "");
        expect(master.status).toBe(200);
        const segment = await manager.serve(scope, hlsName("0.m4s"), "");
        expect(segment.status).toBe(200);
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
    "a request at the idle boundary waits for cleanup and revives",
    () =>
      withSession(
        async ({ manager, scope, scratchDir }) => {
          // idleMs 300: the first segment lands well inside it, and the stop
          // has at least started by the second request.
          for (let round = 0; round < 3; round += 1) {
            const first = await manager.serve(scope, hlsName("0.m4s"), "");
            expect(first.status).toBe(200);
            await first.body?.cancel();
            await Bun.sleep(400);
            const revived = await manager.serve(scope, hlsName("0.m4s"), "");
            expect(revived.status).toBe(200);
            await revived.body?.cancel();
            expect((await manager.inspect(scope.sessionId))?.runs).toBe(1);
            const sessionDir = join(scratchDir, scope.sessionId);
            expect(await pathExists(sessionDir)).toBe(true);
            const entries = await readdir(sessionDir);
            expect(entries.some((name) => name.startsWith("run-"))).toBe(true);
          }
        },
        { idleMs: 300 },
      ),
    30_000,
  );

  test(
    "serve after stop answers 503 TRANSCODER_STOPPING and stop leaves no session",
    () =>
      withSession(async ({ manager, scope, scratchDir }) => {
        await manager.serve(scope, hlsName("master.m3u8"), "");
        await manager.stop();
        const after = await manager.serve(scope, hlsName("master.m3u8"), "");
        expect(after.status).toBe(503);
        expect(after.headers.get("retry-after")).toBe("1");
        const body = (await after.json()) as {
          error?: { code?: string };
        };
        expect(body.error?.code).toBe("TRANSCODER_STOPPING");
        expect(await manager.inspect(scope.sessionId)).toBeUndefined();
        expect(await pathExists(join(scratchDir, scope.sessionId))).toBe(false);
      }),
    30_000,
  );

  test(
    "a request still loading when stop begins answers 503 and leaves no process or scratch",
    () =>
      withSession(async ({ manager, scope, scratchDir }) => {
        // The first request is inside loadSession's queries when stop runs.
        const admitted = manager.serve(scope, hlsName("master.m3u8"), "");
        await manager.stop();
        const response = await admitted;
        expect(response.status).toBe(503);
        const body = (await response.json()) as {
          error?: { code?: string };
        };
        expect(body.error?.code).toBe("TRANSCODER_STOPPING");
        expect(await manager.inspect(scope.sessionId)).toBeUndefined();
        expect(await pathExists(join(scratchDir, scope.sessionId))).toBe(false);
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
