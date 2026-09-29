import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { sessionRegistry, transcoderCapabilities } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import type { pendiaRouter } from "./router.ts";

HLS.setOptions({ strictMode: true });

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

// The mkv container is not in the profile, so the engine decides remux.
const profile = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr" as const],
};

const serverDir = resolve(import.meta.dir, "../..");

function rpcClient(base: string, token?: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof pendiaRouter>>(link);
}

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const owner = await createLocalUser(db, admin.id, {
    username: "owner",
    password: "owner-pass",
  });
  await login(
    db,
    { username: "owner", password: "owner-pass", ...device },
    "127.0.0.1",
  );
  const { token: keyToken } = await createApiKey(db, owner.id, "player");
  return { admin, owner, keyToken };
}

const pathExists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const jsonError = async (response: Response) => {
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  return body.error;
};

// A free TCP port for the child: readPort rejects 0, so probe one first.
const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  void probe.stop(true);
  return port;
};

describe.skipIf(!databaseUrl)("hls proxy", () => {
  let libraryRoot: string;

  beforeAll(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "pendia-hls-proxy-library-"));
    const folder = join(libraryRoot, "Movie (2026)");
    await mkdir(folder);
    await createVideoFixture(join(folder, "Movie.mkv"), {
      width: 1920,
      height: 1080,
      durationSeconds: 12,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
    });
  }, 60_000);

  afterAll(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  test(
    "a session is served through the proxy when the transcoder is another process",
    () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const fx = await seed(db);
        const library = await createLibrary(db, fx.admin.id, {
          name: "Movies",
          medium: "movies",
          rootPath: libraryRoot,
        });
        const scanned = await scanDirectory(db, library.id, "Movie (2026)");
        const versionId = scanned.versionIds[0];
        if (scanned.itemId === null || versionId === undefined) {
          throw new Error("Expected exactly one scanned item and version.");
        }
        const itemId = scanned.itemId;
        const scratchDir = await mkdtemp(
          join(tmpdir(), "pendia-hls-proxy-scratch-"),
        );
        const env: Record<string, string | undefined> = {
          ...process.env,
          DATABASE_URL: url,
          PENDIA_TRANSCODER_PORT: String(freePort()),
          PENDIA_SCRATCH_DIR: scratchDir,
        };
        delete env.PENDIA_TRANSCODER_URL;
        const child = Bun.spawn(
          [process.execPath, "src/index.ts", "--role", "transcoder"],
          {
            cwd: serverDir,
            env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const stdoutText = new Response(child.stdout).text();
        const stderrText = new Response(child.stderr).text();
        let server: Awaited<ReturnType<typeof startPendia>> | undefined;
        try {
          let node: { id: string; address: string } | undefined;
          const registeredBy = Date.now() + 15_000;
          while (Date.now() < registeredBy) {
            const [row] = await db
              .select({
                id: transcoderCapabilities.id,
                address: transcoderCapabilities.address,
              })
              .from(transcoderCapabilities);
            if (row !== undefined) {
              node = row;
              break;
            }
            if (child.exitCode !== null) {
              throw new Error(
                `Transcoder child exited ${child.exitCode}: ${await stderrText}`,
              );
            }
            await Bun.sleep(100);
          }
          if (node === undefined) {
            throw new Error("Transcoder child never registered a node.");
          }
          expect(node.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
          const health = await fetch(`${node.address}/healthz`);
          expect(health.status).toBe(200);
          await health.body?.cancel();

          server = await startPendia("api", { databaseUrl: url, port: 0 });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = rpcClient(base, fx.keyToken);
          const planned = await client.playback.plan({
            itemId,
            versionId,
            profile,
          });
          expect(planned.method).toBe("remux");
          if (planned.sessionId === null || planned.url === null) {
            throw new Error("Remux must return a session and URL.");
          }
          const sessionId = planned.sessionId;

          const master = await fetch(new URL(planned.url, base));
          expect(master.status).toBe(200);
          expect(master.headers.get("content-type")).toBe(
            "application/vnd.apple.mpegurl",
          );
          const masterUrl = new URL(master.url);
          const masterPlaylist = HLS.parse(await master.text());
          if (!masterPlaylist.isMasterPlaylist) {
            throw new Error("Expected a master playlist.");
          }
          const mediaUri = masterPlaylist.variants[0]?.uri;
          if (mediaUri === undefined) throw new Error("Missing media URI.");
          const media = await fetch(new URL(mediaUri, masterUrl));
          expect(media.status).toBe(200);
          const mediaUrl = new URL(media.url);
          const mediaPlaylist = HLS.parse(await media.text());
          if (mediaPlaylist.isMasterPlaylist) {
            throw new Error("Expected a media playlist.");
          }
          const initUri = mediaPlaylist.segments[0]?.map?.uri;
          if (initUri === undefined) throw new Error("Missing init URI.");
          const init = await fetch(new URL(initUri, mediaUrl));
          expect(init.status).toBe(200);
          await init.body?.cancel();
          const segmentUri = mediaPlaylist.segments[0]?.uri;
          if (segmentUri === undefined) throw new Error("Missing segment URI.");
          const segment = await fetch(new URL(segmentUri, mediaUrl));
          expect(segment.status).toBe(200);
          expect(segment.headers.get("content-type")).toBe("video/iso.segment");
          expect((await segment.arrayBuffer()).byteLength).toBeGreaterThan(0);

          const [owned] = await db
            .select({ transcoderNodeId: sessionRegistry.transcoderNodeId })
            .from(sessionRegistry)
            .where(eq(sessionRegistry.id, sessionId));
          expect(owned?.transcoderNodeId).toBe(node.id);
          const sessionDir = join(scratchDir, sessionId);
          expect(await pathExists(sessionDir)).toBe(true);

          child.kill("SIGTERM");
          const exitCode = await Promise.race([
            child.exited,
            Bun.sleep(10_000).then(() => null),
          ]);
          expect(exitCode).toBe(0);
          expect(
            await db
              .select({ id: transcoderCapabilities.id })
              .from(transcoderCapabilities),
          ).toHaveLength(0);
          const [released] = await db
            .select({ transcoderNodeId: sessionRegistry.transcoderNodeId })
            .from(sessionRegistry)
            .where(eq(sessionRegistry.id, sessionId));
          expect(released?.transcoderNodeId).toBeNull();
          expect(await pathExists(sessionDir)).toBe(false);

          const orphaned = await fetch(new URL(planned.url, base));
          expect(orphaned.status).toBe(503);
          expect((await jsonError(orphaned))?.code).toBe("NO_TRANSCODER");

          const stdout = await stdoutText;
          expect(stdout).toContain('"message":"transcoder.listening"');
          expect(stdout).toContain('"message":"session.stopped"');
          expect(stdout).toContain('"reason":"shutdown"');
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
          await child.exited;
          await server?.stop();
          await rm(scratchDir, { recursive: true, force: true });
        }
      }),
    60_000,
  );
});
