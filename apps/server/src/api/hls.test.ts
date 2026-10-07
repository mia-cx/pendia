import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  sessionRegistry,
  transcoderCapabilities,
  versions,
} from "../db/schema/index.ts";
import {
  databaseUrl,
  runQueuedKeyframeIndexes,
  withDatabase,
} from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import type { thaliaRouter } from "./router.ts";

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

function rpcClient(base: string, token?: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof thaliaRouter>>(link);
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
  const { token: accountToken } = await login(
    db,
    { username: "owner", password: "owner-pass", ...device },
    "127.0.0.1",
  );
  const { token: keyToken } = await createApiKey(db, owner.id, "player");
  return { admin, owner, accountToken, keyToken };
}

const pathExists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const probeDuration = async (path: string) => {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
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
  return Number(output.trim());
};

const ffmpegDecode = async (path: string) => {
  const proc = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", path, "-f", "null", "-"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr: stderr.trim(), exitCode };
};

const jsonError = async (response: Response) => {
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  return body.error;
};

describe.skipIf(!databaseUrl)("hls playback", () => {
  let libraryRoot: string;

  beforeAll(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "thalia-hls-api-library-"));
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

  const withServer = async (
    run: (context: {
      db: Database;
      base: string;
      client: ReturnType<typeof rpcClient>;
      itemId: string;
      versionId: string;
      scratchDir: string;
      server: Awaited<ReturnType<typeof startThalia>>;
      keyToken: string;
    }) => Promise<void>,
    options: { index?: boolean } = {},
  ) => {
    await withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const library = await createLibrary(db, fx.admin.id, {
        name: "Movies",
        medium: "movies",
        roots: [libraryRoot],
      });
      const scanned = await scanDirectory(db, library.id, "Movie (2026)");
      if (options.index !== false) await runQueuedKeyframeIndexes(db);
      const versionId = scanned.versionIds[0];
      if (scanned.itemId === null || versionId === undefined) {
        throw new Error("Expected exactly one scanned item and version.");
      }
      const scratchDir = await mkdtemp(
        join(tmpdir(), "thalia-hls-api-scratch-"),
      );
      const server = await startThalia("all", {
        databaseUrl: url,
        port: 0,
        transcoderOptions: {
          port: 0,
          scratchDir,
          idleMs: 500,
          waitMs: 400,
          readRate: { rate: 1, initialBurstSeconds: 3.5 },
        },
      });
      try {
        await run({
          db,
          base: `http://127.0.0.1:${server.apiServer?.port}`,
          client: rpcClient(
            `http://127.0.0.1:${server.apiServer?.port}`,
            fx.keyToken,
          ),
          itemId: scanned.itemId,
          versionId,
          scratchDir,
          server,
          keyToken: fx.keyToken,
        });
      } finally {
        await server.stop();
        await rm(scratchDir, { recursive: true, force: true });
      }
    });
  };

  const planRemux = async (
    client: ReturnType<typeof rpcClient>,
    itemId: string,
    versionId: string,
  ) => {
    const planned = await client.playback.plan({ itemId, versionId, profile });
    if (planned.sessionId === null || planned.url === null) {
      throw new Error("Remux must return a session and URL.");
    }
    return {
      sessionId: planned.sessionId,
      url: planned.url,
      expiresAt: planned.expiresAt,
    };
  };

  const fetchHls = async (
    playlistUrl: URL,
    uri: string | undefined,
  ): Promise<Response> => {
    if (uri === undefined) throw new Error("Missing playlist URI.");
    return fetch(new URL(uri, playlistUrl));
  };

  test(
    "plays a 1080p fixture over HLS",
    () =>
      withServer(
        async ({ db, client, itemId, versionId, scratchDir, server }) => {
          const planned = await planRemux(client, itemId, versionId);
          expect(planned.expiresAt).not.toBeNull();
          const sessionId = planned.sessionId;

          const startedAt = performance.now();
          const master = await fetch(
            new URL(planned.url, `http://127.0.0.1:${server.apiServer?.port}`),
          );
          expect(master.status).toBe(200);
          expect(master.headers.get("content-type")).toBe(
            "application/vnd.apple.mpegurl",
          );
          const masterUrl = new URL(master.url);
          const masterPlaylist = HLS.parse(await master.text());
          if (!masterPlaylist.isMasterPlaylist) {
            throw new Error("Expected a master playlist.");
          }
          expect(masterPlaylist.variants).toHaveLength(1);
          const variant = masterPlaylist.variants[0];
          expect(variant?.resolution).toEqual({ width: 1920, height: 1080 });
          expect(variant?.codecs?.startsWith("avc1.")).toBe(true);
          expect(variant?.uri).toContain("media.m3u8?token=");

          const media = await fetchHls(masterUrl, variant?.uri);
          expect(media.status).toBe(200);
          const mediaUrl = new URL(media.url);
          const mediaPlaylist = HLS.parse(await media.text());
          if (mediaPlaylist.isMasterPlaylist) {
            throw new Error("Expected a media playlist.");
          }
          expect(mediaPlaylist.segments).toHaveLength(4);
          expect(mediaPlaylist.endlist).toBe(true);
          expect(mediaPlaylist.segments[0]?.map?.uri).toContain("token=");

          const init = await fetchHls(
            mediaUrl,
            mediaPlaylist.segments[0]?.map?.uri,
          );
          expect(init.status).toBe(200);
          expect(init.headers.get("content-type")).toBe("video/mp4");
          const initBytes = Buffer.from(await init.arrayBuffer());
          expect(initBytes.length).toBeGreaterThan(0);

          const segment0 = await fetchHls(
            mediaUrl,
            mediaPlaylist.segments[0]?.uri,
          );
          expect(segment0.status).toBe(200);
          expect(segment0.headers.get("content-type")).toBe(
            "video/iso.segment",
          );
          const segment0Bytes = Buffer.from(await segment0.arrayBuffer());
          expect(segment0Bytes.length).toBeGreaterThan(0);
          const firstPlayable = performance.now() - startedAt;
          console.info(
            `first playable segment in ${Math.round(firstPlayable)} ms`,
          );
          expect(firstPlayable).toBeLessThan(500);

          const [row] = await db
            .select({ transcoderNodeId: sessionRegistry.transcoderNodeId })
            .from(sessionRegistry)
            .where(eq(sessionRegistry.id, sessionId));
          expect(row?.transcoderNodeId).toBe(server.transcoder?.nodeId);

          const seekAt = performance.now();
          const segment3 = await fetchHls(
            mediaUrl,
            mediaPlaylist.segments[3]?.uri,
          );
          const seekElapsed = performance.now() - seekAt;
          expect(segment3.status).toBe(200);
          expect(seekElapsed).toBeLessThan(2_000);
          console.info(`seek served in ${Math.round(seekElapsed)} ms`);
          const segment3Bytes = Buffer.from(await segment3.arrayBuffer());
          expect(
            (await server.transcoder?.sessions.inspect(sessionId))?.runs,
          ).toBe(2);

          const cached = await fetchHls(
            mediaUrl,
            mediaPlaylist.segments[0]?.uri,
          );
          expect(cached.status).toBe(200);
          expect(
            (await server.transcoder?.sessions.inspect(sessionId))?.runs,
          ).toBe(2);

          const segment1 = await fetchHls(
            mediaUrl,
            mediaPlaylist.segments[1]?.uri,
          );
          expect(segment1.status).toBe(200);
          const segment1Bytes = Buffer.from(await segment1.arrayBuffer());
          expect(
            (await server.transcoder?.sessions.inspect(sessionId))?.runs,
          ).toBe(3);

          let segment2Bytes: Buffer | null = null;
          const deadline = Date.now() + 6_000;
          while (Date.now() < deadline) {
            const pending = await fetchHls(
              mediaUrl,
              mediaPlaylist.segments[2]?.uri,
            );
            if (pending.status === 200) {
              segment2Bytes = Buffer.from(await pending.arrayBuffer());
              break;
            }
            await pending.body?.cancel();
            await Bun.sleep(100);
          }
          if (segment2Bytes === null) {
            throw new Error("Segment 2 never became ready.");
          }

          const [versionRow] = await db
            .select({ durationSeconds: versions.durationSeconds })
            .from(versions)
            .where(eq(versions.id, versionId));
          const joined = join(scratchDir, "joined.mp4");
          await writeFile(
            joined,
            Buffer.concat([
              initBytes,
              segment0Bytes,
              segment1Bytes,
              segment2Bytes,
              segment3Bytes,
            ]),
          );
          const duration = await probeDuration(joined);
          expect(
            Math.abs(duration - (versionRow?.durationSeconds ?? 0)),
          ).toBeLessThan(0.1);
          const decoded = await ffmpegDecode(joined);
          expect(decoded.exitCode).toBe(0);
          expect(decoded.stderr).toBe("");
        },
      ),
    30_000,
  );

  test(
    "waits for the next segment and answers 503 on timeout",
    () =>
      withServer(async ({ base, client, itemId, versionId }) => {
        const planned = await planRemux(client, itemId, versionId);
        const master = await fetch(new URL(planned.url, base));
        expect(master.status).toBe(200);
        const hls = (name: string) => {
          const url = new URL(planned.url, base);
          url.pathname = url.pathname.replace(/master\.m3u8$/, name);
          return url;
        };
        const init = await fetch(hls("init.mp4"));
        expect(init.status).toBe(200);
        await init.body?.cancel();
        const segment0 = await fetch(hls("0.m4s"));
        expect(segment0.status).toBe(200);
        await segment0.body?.cancel();

        const waitedAt = performance.now();
        const pending = await fetch(hls("1.m4s"));
        const elapsed = performance.now() - waitedAt;
        expect(pending.status).toBe(503);
        expect(pending.headers.get("retry-after")).toBe("1");
        expect((await jsonError(pending))?.code).toBe("SEGMENT_NOT_READY");
        expect(elapsed).toBeGreaterThanOrEqual(350);
        expect(elapsed).toBeLessThan(1_500);
      }),
    30_000,
  );

  test(
    "an idle session stops, its scratch is deleted, and a request revives it",
    () =>
      withServer(
        async ({ db, base, client, itemId, versionId, scratchDir, server }) => {
          const planned = await planRemux(client, itemId, versionId);
          const sessionId = planned.sessionId;
          const hls = (name: string) => {
            const url = new URL(planned.url, base);
            url.pathname = url.pathname.replace(/master\.m3u8$/, name);
            return url;
          };
          const master = await fetch(hls("master.m3u8"));
          expect(master.status).toBe(200);
          await master.body?.cancel();
          const segment0 = await fetch(hls("0.m4s"));
          expect(segment0.status).toBe(200);
          await segment0.body?.cancel();
          const sessionDir = join(scratchDir, sessionId);
          expect(await pathExists(sessionDir)).toBe(true);

          await Bun.sleep(1_200);
          expect(
            await server.transcoder?.sessions.inspect(sessionId),
          ).toBeUndefined();
          expect(await pathExists(sessionDir)).toBe(false);
          const [row] = await db
            .select({ state: sessionRegistry.state })
            .from(sessionRegistry)
            .where(eq(sessionRegistry.id, sessionId));
          expect(row?.state).toBe("starting");

          const segment2 = await fetch(hls("2.m4s"));
          expect(segment2.status).toBe(200);
          await segment2.body?.cancel();
          expect(await pathExists(sessionDir)).toBe(true);
        },
      ),
    30_000,
  );

  test(
    "rejects a bad token, a foreign name and a stopped session",
    () =>
      withServer(async ({ base, client, itemId, versionId }) => {
        const planned = await planRemux(client, itemId, versionId);
        const sessionId = planned.sessionId;
        const token = new URL(planned.url, base).searchParams.get("token");
        if (token === null) throw new Error("Missing playback token.");
        const hls = (name: string, auth: string | null) => {
          const url = new URL(
            `/api/playback/${sessionId}/${itemId}/hls/${name}`,
            base,
          );
          if (auth !== null) url.searchParams.set("token", auth);
          return url;
        };

        const bad = await fetch(hls("master.m3u8", "bad"));
        expect(bad.status).toBe(401);
        await bad.body?.cancel();

        const foreign = await fetch(hls("evil.txt", token));
        expect(foreign.status).toBe(404);
        await foreign.body?.cancel();

        await client.playback.stop({
          sessionId,
          itemId,
          positionSeconds: 0,
        });
        const stopped = await fetch(hls("master.m3u8", token));
        expect(stopped.status).toBe(401);
        await stopped.body?.cancel();
      }),
    30_000,
  );

  test(
    "answers 503 without a transcoder",
    () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const fx = await seed(db);
        const library = await createLibrary(db, fx.admin.id, {
          name: "Movies",
          medium: "movies",
          roots: [libraryRoot],
        });
        const scanned = await scanDirectory(db, library.id, "Movie (2026)");
        await runQueuedKeyframeIndexes(db);
        const versionId = scanned.versionIds[0];
        if (scanned.itemId === null || versionId === undefined) {
          throw new Error("Expected exactly one scanned item and version.");
        }
        const server = await startThalia("api", {
          databaseUrl: url,
          port: 0,
        });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = rpcClient(base, fx.keyToken);
          const planned = await client.playback.plan({
            itemId: scanned.itemId,
            versionId,
            profile,
          });
          expect(planned.method).toBe("remux");
          if (planned.url === null) {
            throw new Error("Remux must return a URL.");
          }
          const master = await fetch(new URL(planned.url, base));
          expect(master.status).toBe(503);
          expect(master.headers.get("retry-after")).toBe("5");
          expect((await jsonError(master))?.code).toBe("NO_TRANSCODER");
        } finally {
          await server.stop();
        }
      }),
    30_000,
  );

  test(
    "answers 503 NO_TRANSCODER when the local node row is gone",
    () =>
      withServer(async ({ db, base, client, itemId, versionId, server }) => {
        const nodeId = server.transcoder?.nodeId;
        if (nodeId === undefined) {
          throw new Error("Expected a local transcoder.");
        }
        await db
          .delete(transcoderCapabilities)
          .where(eq(transcoderCapabilities.id, nodeId));
        const planned = await planRemux(client, itemId, versionId);
        const master = await fetch(new URL(planned.url, base));
        expect(master.status).toBe(503);
        expect(master.headers.get("retry-after")).toBe("5");
        expect((await jsonError(master))?.code).toBe("NO_TRANSCODER");
      }),
    30_000,
  );
});

describe.skipIf(!databaseUrl)("progressive playback", () => {
  let libraryRoot: string;

  beforeAll(async () => {
    libraryRoot = await mkdtemp(
      join(tmpdir(), "thalia-progressive-api-library-"),
    );
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

  const withProgressive = async (
    run: (context: {
      db: Database;
      base: string;
      client: ReturnType<typeof rpcClient>;
      itemId: string;
      versionId: string;
      server: Awaited<ReturnType<typeof startThalia>>;
      keyToken: string;
    }) => Promise<void>,
    options: { index?: boolean } = {},
  ) => {
    await withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const library = await createLibrary(db, fx.admin.id, {
        name: "Movies",
        medium: "movies",
        roots: [libraryRoot],
      });
      const scanned = await scanDirectory(db, library.id, "Movie (2026)");
      if (options.index !== false) await runQueuedKeyframeIndexes(db);
      const versionId = scanned.versionIds[0];
      if (scanned.itemId === null || versionId === undefined) {
        throw new Error("Expected exactly one scanned item and version.");
      }
      const server = await startThalia("all", {
        databaseUrl: url,
        port: 0,
        transcoderOptions: {
          port: 0,
          scratchDir: await mkdtemp(join(tmpdir(), "thalia-prog-scratch-")),
          idleMs: 500,
          waitMs: 400,
        },
      });
      try {
        await run({
          db,
          base: `http://127.0.0.1:${server.apiServer?.port}`,
          client: rpcClient(
            `http://127.0.0.1:${server.apiServer?.port}`,
            fx.keyToken,
          ),
          itemId: scanned.itemId,
          versionId,
          server,
          keyToken: fx.keyToken,
        });
      } finally {
        await server.stop();
      }
    });
  };

  const planProgressive = async (
    client: ReturnType<typeof rpcClient>,
    itemId: string,
    versionId: string,
    subtitleStreamIndex?: number,
  ) => {
    const planned = await client.playback.plan({
      itemId,
      versionId,
      profile: { ...profile, progressive: true },
      ...(subtitleStreamIndex === undefined ? {} : { subtitleStreamIndex }),
    });
    if (planned.sessionId === null || planned.url === null) {
      throw new Error("A progressive plan must return a session and URL.");
    }
    return planned;
  };

  test(
    "an unindexed Version streams progressive fMP4",
    () =>
      withProgressive(
        async ({ base, client, itemId, versionId }) => {
          const planned = await planProgressive(client, itemId, versionId);
          expect(planned.delivery).toBe("progressive");
          expect(planned.url).toMatch(/\/stream\?token=/);
          const stream = await fetch(new URL(planned.url ?? "", base));
          if (stream.status !== 200)
            console.log("STREAM ERR", stream.status, await stream.text());
          expect(stream.status).toBe(200);
          expect(stream.headers.get("content-type")).toBe("video/mp4");
          expect(stream.headers.get("x-stream-offset")).toBe("0");
          const reader = stream.body?.getReader();
          const head = await reader?.read();
          expect(head?.value?.length).toBeGreaterThan(0);
          // ftyp leads a fragmented MP4 stream.
          const magic = String.fromCharCode(
            ...(head?.value?.slice(4, 8) ?? []),
          );
          expect(magic).toBe("ftyp");
          await reader?.cancel();
        },
        { index: false },
      ),
    30_000,
  );

  test(
    "a seek carries an offset header and absolute subtitles",
    () =>
      withProgressive(
        async ({ base, client, itemId, versionId }) => {
          const planned = await planProgressive(client, itemId, versionId, 2);
          const token = new URL(planned.url ?? "", base).searchParams.get(
            "token",
          );
          const at = new URL(
            `/api/playback/${planned.sessionId}/${itemId}/stream`,
            base,
          );
          at.searchParams.set("token", token ?? "");
          at.searchParams.set("start", "6");
          const stream = await fetch(at);
          expect(stream.status).toBe(200);
          // The copy lands on the keyframe at 6 s.
          expect(Number(stream.headers.get("x-stream-offset"))).toBeCloseTo(
            6,
            0,
          );
          await stream.body?.cancel();
          expect(planned.subtitleUrl).toMatch(/\/subtitles\/2\.vtt\?token=/);
          const subtitles = await fetch(
            new URL(planned.subtitleUrl ?? "", base),
          );
          expect(subtitles.status).toBe(200);
          expect(subtitles.headers.get("content-type")).toBe("text/vtt");
          expect(await subtitles.text()).toContain("WEBVTT");
        },
        { index: false },
      ),
    30_000,
  );

  test(
    "the stream route rejects an hls session and vice versa",
    () =>
      withProgressive(async ({ base, client, itemId, versionId }) => {
        const hlsPlanResult = await client.playback.plan({
          itemId,
          versionId,
          profile,
        });
        if (hlsPlanResult.sessionId === null || hlsPlanResult.url === null) {
          throw new Error("An HLS plan must return a session and URL.");
        }
        const hlsPlan = {
          sessionId: hlsPlanResult.sessionId,
          url: hlsPlanResult.url,
        };
        const hlsToken = new URL(hlsPlan.url, base).searchParams.get("token");
        const asStream = await fetch(
          new URL(
            `/api/playback/${hlsPlan.sessionId}/${itemId}/stream?token=${hlsToken}`,
            base,
          ),
        );
        expect(asStream.status).toBe(404);
        await asStream.body?.cancel();
        const subAsHls = await fetch(
          new URL(
            `/api/playback/${hlsPlan.sessionId}/${itemId}/subtitles/2.vtt?token=${hlsToken}`,
            base,
          ),
        );
        expect(subAsHls.status).toBe(404);
        await subAsHls.body?.cancel();

        const progressivePlan = await planProgressive(
          client,
          itemId,
          versionId,
        );
        const token = new URL(progressivePlan.url ?? "", base).searchParams.get(
          "token",
        );
        const asHls = await fetch(
          new URL(
            `/api/playback/${progressivePlan.sessionId}/${itemId}/hls/master.m3u8?token=${token}`,
            base,
          ),
        );
        expect(asHls.status).toBe(404);
        await asHls.body?.cancel();
        // A bad start and an unknown subtitle are bad input / not found.
        const badStart = await fetch(
          new URL(
            `/api/playback/${progressivePlan.sessionId}/${itemId}/stream?token=${token}&start=-1`,
            base,
          ),
        );
        expect(badStart.status).toBe(400);
        await badStart.body?.cancel();
        const badSubtitle = await fetch(
          new URL(
            `/api/playback/${progressivePlan.sessionId}/${itemId}/subtitles/99.vtt?token=${token}`,
            base,
          ),
        );
        expect(badSubtitle.status).toBe(404);
        await badSubtitle.body?.cancel();
      }),
    30_000,
  );
});
