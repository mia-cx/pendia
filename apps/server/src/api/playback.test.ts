import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { setPermissionOverride } from "../auth/permissions.ts";
import {
  issuePlaybackToken,
  verifyPlaybackToken,
} from "../auth/playback-tokens.ts";
import { authenticate, createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  events,
  files,
  items,
  jobs,
  libraryAccess,
  segmentTimelines,
  sessionRegistry,
  settings,
  streams,
  userSettings,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { rootsOf } from "../libraries/roots.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { planPlayback, refreshPlayback } from "../playback/planning.ts";
import {
  writeGlobalBitrateCap,
  writePlaybackSettings,
} from "../playback/settings.ts";
import type { thaliaRouter } from "./router.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

function rpcClient(base: string, token?: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof thaliaRouter>>(link);
}

type ApiClient = ReturnType<typeof rpcClient>;
type PlanArgs = NonNullable<Parameters<ApiClient["playback"]["plan"]>[0]>;

const profile: PlanArgs["profile"] = {
  containers: ["mp4"],
  videoCodecs: [
    {
      codec: "h264",
      profiles: ["high"],
      maxLevel: 41,
      maxWidth: 1920,
      maxHeight: 1080,
    },
  ],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr"],
};

async function capture(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("Expected the client call to reject.");
}

type MediaOptions = {
  container?: string;
  audioCodec?: string;
  audioProfile?: string | null;
  audioChannels?: number;
  subtitleCodec?: string;
  attachedPicture?: boolean;
};

async function addItem(db: Database, libraryId: string, title: string) {
  const [item] = await db
    .insert(items)
    .values({
      libraryId,
      kind: "movie",
      title,
      canonicalFolder: `/srv/movies/${title.toLowerCase()}`,
    })
    .returning();
  if (!item) throw new Error("Item insert returned no row.");
  return item;
}

async function addMedia(
  db: Database,
  libraryId: string,
  itemId: string,
  options: MediaOptions = {},
) {
  const [version] = await db
    .insert(versions)
    .values({
      itemId,
      itemKind: "movie",
      libraryId,
      label: "Original",
      format: "video",
      bytes: 75_000_000n,
      durationSeconds: 120,
    })
    .returning();
  if (!version) throw new Error("Version insert returned no row.");
  const [root] = await rootsOf(db, libraryId);
  if (!root) throw new Error("Library has no root.");
  const [file] = await db
    .insert(files)
    .values({
      versionId: version.id,
      itemId,
      libraryId,
      rootId: root.id,
      path: `/srv/movies/file-${version.id}.mp4`,
      order: 0,
      bytes: 75_000_000n,
      modifiedAt: new Date(),
      container: options.container ?? "mp4",
      durationSeconds: 120,
    })
    .returning();
  if (!file) throw new Error("File insert returned no row.");
  await db.insert(streams).values([
    {
      versionId: version.id,
      fileId: file.id,
      index: 0,
      kind: "video",
      codec: "h264",
      profile: "high",
      level: 41,
      width: 1920,
      height: 1080,
      bitrate: 5_000_000n,
      hdr: "sdr",
    },
    {
      versionId: version.id,
      fileId: file.id,
      index: 1,
      kind: "audio",
      codec: options.audioCodec ?? "aac",
      profile: options.audioProfile ?? null,
      channels: options.audioChannels ?? 2,
    },
    {
      versionId: version.id,
      fileId: file.id,
      index: 2,
      kind: "subtitle",
      codec: options.subtitleCodec ?? "subrip",
    },
  ]);
  if (options.attachedPicture)
    await db.insert(streams).values({
      versionId: version.id,
      fileId: file.id,
      index: 3,
      kind: "video",
      codec: "mjpeg",
      disposition: { attached_pic: true },
    });
  return { version, file };
}

async function alignTimeline(
  db: Database,
  version: { id: string; itemId: string; durationSeconds: number | null },
  aligned = true,
) {
  const duration = version.durationSeconds;
  if (duration === null) throw new Error("Version has no duration.");
  const [timeline] = await db
    .insert(segmentTimelines)
    .values({
      itemId: version.itemId,
      cutKey: "original",
      boundariesSeconds: [0, 4, duration],
    })
    .returning();
  if (!timeline) throw new Error("Timeline insert returned no row.");
  await db
    .update(versions)
    .set({ segmentTimelineId: timeline.id, timelineAligned: aligned })
    .where(eq(versions.id, version.id));
}

async function seedPlayback(
  db: Database,
  username = "owner",
  options: MediaOptions = {},
) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const owner = await createLocalUser(db, admin.id, {
    username,
    password: "owner-pass",
  });
  const { token: accountToken } = await login(
    db,
    { username, password: "owner-pass", ...device },
    "127.0.0.1",
  );
  const caller = await authenticate(db, accountToken);
  const { token: keyToken } = await createApiKey(db, owner.id, "player");
  const keyCaller = await authenticate(db, keyToken);
  const [library] = await insertLibraries(db, {
    name: "Movies",
    medium: "movies",
    rootPath: "/srv/movies",
  });
  if (!library) throw new Error("Library insert returned no row.");
  const item = await addItem(db, library.id, "Movie");
  const { version, file } = await addMedia(db, library.id, item.id, options);
  return {
    admin,
    owner,
    caller,
    keyCaller,
    accountToken,
    keyToken,
    library,
    item,
    version,
    file,
  };
}

function planRequest(forwardedFor?: string) {
  return new Request("http://thalia.test/api/playback/plan", {
    method: "POST",
    headers:
      forwardedFor === undefined
        ? { authorization: "Bearer service" }
        : {
            authorization: "Bearer service",
            "x-forwarded-for": forwardedFor,
          },
  });
}

describe.skipIf(!databaseUrl)("api playback", () => {
  test("direct play returns a scoped token URL and a starting session", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const planned = await client.playback.plan({
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile,
        });
        expect(planned).toMatchObject({
          method: "direct-play",
          itemId: fx.item.id,
          versionId: fx.version.id,
        });
        if (planned.sessionId === null || planned.url === null)
          throw new Error("Expected a session and URL.");
        expect(planned.expiresAt).not.toBeNull();
        const path = `/api/playback/${planned.sessionId}/${fx.item.id}/direct`;
        expect(planned.url.startsWith(`${path}?token=`)).toBe(true);
        const token = new URL(planned.url, base).searchParams.get("token");
        if (token === null) throw new Error("Missing playback token.");
        expect(planned.url).not.toContain(fx.accountToken);
        expect(planned.url).not.toContain(fx.keyToken);
        const claims = await verifyPlaybackToken(db, token, {
          sessionId: planned.sessionId,
          itemId: fx.item.id,
        });
        expect(claims.userId).toBe(fx.owner.id);
        expect(claims.credential).toEqual(fx.keyCaller.credential);
        const [registry] = await db
          .select()
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, planned.sessionId));
        expect(registry).toMatchObject({
          userId: fx.owner.id,
          itemId: fx.item.id,
          versionId: fx.version.id,
          playMethod: "direct-play",
          state: "starting",
          transcoderNodeId: null,
        });
        expect(registry?.decision?.method).toBe("direct-play");

        const rest = await fetch(`${base}/api/playback/plan`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${fx.keyToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            itemId: fx.item.id,
            versionId: fx.version.id,
            profile,
          }),
        });
        expect(rest.status).toBe(200);
        const body = (await rest.json()) as {
          method: string;
          sessionId: string | null;
          url: string | null;
        };
        expect(body.method).toBe("direct-play");
        expect(body.url).toContain(
          `/api/playback/${body.sessionId}/${fx.item.id}/direct?token=`,
        );
      } finally {
        await server.stop();
      }
    }));

  test("a cookie caller receives a token-free direct URL", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const rest = await fetch(`${base}/api/playback/plan`, {
          method: "POST",
          headers: {
            cookie: `thalia_session=${fx.accountToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            itemId: fx.item.id,
            versionId: fx.version.id,
            profile,
          }),
        });
        expect(rest.status).toBe(200);
        const body = (await rest.json()) as {
          method: string;
          sessionId: string | null;
          url: string | null;
          expiresAt: string | null;
        };
        expect(body.method).toBe("direct-play");
        expect(body.url).toBe(
          `/api/playback/${body.sessionId}/${fx.item.id}/direct`,
        );
        expect(body.expiresAt).toBeNull();
      } finally {
        await server.stop();
      }
    }));

  test("remux and transcode both open a session with a master playlist URL", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      await alignTimeline(db, fx.version);
      const second = await addItem(db, fx.library.id, "Sequel");
      await addMedia(db, fx.library.id, second.id, { audioCodec: "ac3" });
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const remuxed = await client.playback.plan({
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile: { ...profile, containers: ["mkv"] },
        });
        expect(remuxed).toMatchObject({
          method: "remux",
          itemId: fx.item.id,
          versionId: fx.version.id,
        });
        if (remuxed.sessionId === null || remuxed.url === null)
          throw new Error("Remux must return a session and URL.");
        expect(remuxed.expiresAt).not.toBeNull();
        expect(remuxed.url).toMatch(
          new RegExp(
            `^/api/playback/${remuxed.sessionId}/${fx.item.id}/hls/master\\.m3u8\\?token=`,
          ),
        );
        const [remuxRow] = await db
          .select()
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, remuxed.sessionId));
        expect(remuxRow).toMatchObject({
          playMethod: "remux",
          transcoderNodeId: null,
        });
        expect(remuxRow?.decision).toMatchObject({
          method: "remux",
          video: { action: "copy" },
        });

        const [sequelVersion] = await db
          .select()
          .from(versions)
          .where(eq(versions.itemId, second.id));
        if (!sequelVersion) throw new Error("Sequel version missing.");
        await alignTimeline(db, sequelVersion);
        // The AC-3 track alone mismatches: the video copies and audio re-encodes.
        const transcoded = await client.playback.plan({
          itemId: second.id,
          versionId: sequelVersion.id,
          profile,
        });
        expect(transcoded).toMatchObject({
          method: "transcode",
          itemId: second.id,
          versionId: sequelVersion.id,
          subtitles: [],
        });
        if (transcoded.sessionId === null || transcoded.url === null)
          throw new Error("Transcode must return a session and URL.");
        expect(transcoded.expiresAt).not.toBeNull();
        expect(transcoded.url).toMatch(
          new RegExp(
            `^/api/playback/${transcoded.sessionId}/${second.id}/hls/master\\.m3u8\\?token=`,
          ),
        );
        const [transcodeRow] = await db
          .select()
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, transcoded.sessionId));
        expect(transcodeRow).toMatchObject({
          playMethod: "transcode",
          state: "starting",
        });
        expect(transcodeRow?.decision).toMatchObject({
          video: { action: "copy" },
          audio: { action: "transcode", codec: "aac", channels: 2 },
          selection: { audio: 0 },
        });

        const refreshed = await client.playback.refresh({
          sessionId: transcoded.sessionId,
          itemId: second.id,
        });
        expect(refreshed.method).toBe("transcode");
        expect(refreshed.url).toMatch(/\/hls\/master\.m3u8\?token=/);
      } finally {
        await server.stop();
      }
    }));

  test("remux without an aligned timeline answers 409", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      // The index was read but this Version's frames don't align.
      await db
        .update(versions)
        .set({ lazyIndexPending: false })
        .where(eq(versions.id, fx.version.id));
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const failure = await capture(
          client.playback.plan({
            itemId: fx.item.id,
            versionId: fx.version.id,
            profile: { ...profile, containers: ["mkv"] },
          }),
        );
        expect(failure.status).toBe(409);
      } finally {
        await server.stop();
      }
    }));

  test("a transcode needs an aligned timeline whether the video copies or re-encodes", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db, "owner", { audioCodec: "ac3" });
      // Indexed, but not aligned: the gate still refuses HLS.
      await db
        .update(versions)
        .set({ lazyIndexPending: false })
        .where(eq(versions.id, fx.version.id));
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const audioOnly = { itemId: fx.item.id, versionId: fx.version.id };
        // A 720p client re-encodes the 1080p video too.
        const reencode = {
          ...audioOnly,
          profile: {
            ...profile,
            videoCodecs: [{ codec: "h264", maxWidth: 1280, maxHeight: 720 }],
          },
        };
        expect(
          (await capture(client.playback.plan({ ...reencode }))).status,
        ).toBe(409);
        // A timeline whose boundaries are not on this Version's frames: a
        // restarted encode would start a frame late and miss every cut.
        await alignTimeline(db, fx.version, false);
        for (const input of [reencode, { ...audioOnly, profile }]) {
          expect((await capture(client.playback.plan(input))).status).toBe(409);
        }
        await db
          .update(versions)
          .set({ timelineAligned: true })
          .where(eq(versions.id, fx.version.id));
        const planned = await client.playback.plan(reencode);
        expect(planned.method).toBe("transcode");
        expect(planned.url).toMatch(/\/hls\/master\.m3u8\?token=/);
      } finally {
        await server.stop();
      }
    }));

  test("unknown items and foreign versions answer 404", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const otherItem = await addItem(db, fx.library.id, "Other");
      const { version: otherVersion } = await addMedia(
        db,
        fx.library.id,
        otherItem.id,
      );
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const missingItem = await capture(
          client.playback.plan({
            itemId: Bun.randomUUIDv7(),
            versionId: fx.version.id,
            profile,
          }),
        );
        expect(missingItem.status).toBe(404);
        const mismatched = await capture(
          client.playback.plan({
            itemId: fx.item.id,
            versionId: otherVersion.id,
            profile,
          }),
        );
        expect(mismatched.status).toBe(404);
      } finally {
        await server.stop();
      }
    }));

  test("fileless, multi-part and unplayable sources answer 400", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const filelessItem = await addItem(db, fx.library.id, "Fileless");
      const [filelessVersion] = await db
        .insert(versions)
        .values({
          itemId: filelessItem.id,
          itemKind: "movie",
          libraryId: fx.library.id,
          label: "Original",
          format: "video",
          bytes: 1n,
        })
        .returning();
      if (!filelessVersion) throw new Error("Version insert returned no row.");
      const multiItem = await addItem(db, fx.library.id, "Multipart");
      const { version: multiVersion, file: multiFile } = await addMedia(
        db,
        fx.library.id,
        multiItem.id,
      );
      const [secondFile] = await db
        .insert(files)
        .values({
          versionId: multiVersion.id,
          itemId: multiItem.id,
          libraryId: fx.library.id,
          rootId: multiFile.rootId,
          path: `/srv/movies/file-${multiVersion.id}-part2.mp4`,
          order: 1,
          bytes: 1n,
          modifiedAt: new Date(),
          container: "mp4",
        })
        .returning();
      if (!secondFile || !multiFile)
        throw new Error("File insert returned no row.");
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        for (const versionId of [filelessVersion.id, multiVersion.id]) {
          const error = await capture(
            client.playback.plan({
              itemId:
                versionId === filelessVersion.id
                  ? filelessItem.id
                  : multiItem.id,
              versionId,
              profile,
            }),
          );
          expect(error.status).toBe(400);
        }
        const unsupported = await capture(
          client.playback.plan({
            itemId: fx.item.id,
            versionId: fx.version.id,
            profile: {
              ...profile,
              videoCodecs: [{ codec: "vp9" }],
            },
          }),
        );
        expect(unsupported.status).toBe(400);
      } finally {
        await server.stop();
      }
    }));

  test("invalid profile fields and caps answer 400", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const badProfiles = [
          {
            ...profile,
            videoCodecs: [{ codec: "h264", maxWidth: 0 }],
          },
          {
            ...profile,
            videoCodecs: [{ codec: "h264", maxLevel: -1 }],
          },
          { ...profile, videoCodecs: [] },
          { ...profile, audioCodecs: [{ codec: "aac", maxChannels: 0 }] },
        ];
        for (const bad of badProfiles) {
          const error = await capture(
            client.playback.plan({
              itemId: fx.item.id,
              versionId: fx.version.id,
              profile: bad as PlanArgs["profile"],
            }),
          );
          expect(error.status).toBe(400);
        }
        const badCap = await capture(
          client.playback.plan({
            itemId: fx.item.id,
            versionId: fx.version.id,
            profile,
            bitrateCapBps: 0,
          }),
        );
        expect(badCap.status).toBe(400);
        // Stream 0 is video and stream 2 a subtitle; neither is audio.
        const badStreams = [
          { audioStreamIndex: 0 },
          { audioStreamIndex: 2 },
          { audioStreamIndex: -1 },
          { subtitleStreamIndex: 1 },
          { subtitleStreamIndex: 99 },
        ];
        for (const streams of badStreams) {
          const error = await capture(
            client.playback.plan({
              itemId: fx.item.id,
              versionId: fx.version.id,
              profile,
              ...streams,
            }),
          );
          expect(error.status).toBe(400);
        }
      } finally {
        await server.stop();
      }
    }));

  test("denied library view and denied play answer 403", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const viewer = await createLocalUser(db, fx.admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token: viewerToken } = await createApiKey(
        db,
        viewer.id,
        "viewer-key",
      );
      await db.insert(libraryAccess).values({
        libraryId: fx.library.id,
        userId: viewer.id,
        allowed: false,
      });
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const input = {
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile,
        };
        const viewDenied = await capture(
          rpcClient(base, viewerToken).playback.plan(input),
        );
        expect(viewDenied.status).toBe(403);
        const rest = await fetch(`${base}/api/playback/plan`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${viewerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        });
        expect(rest.status).toBe(403);
        await rest.body?.cancel();

        await setPermissionOverride(db, fx.admin.id, viewer.id, "play", false);
        await db
          .delete(libraryAccess)
          .where(eq(libraryAccess.userId, viewer.id));
        const playDenied = await capture(
          rpcClient(base, viewerToken).playback.plan(input),
        );
        expect(playDenied.status).toBe(403);
      } finally {
        await server.stop();
      }
    }));

  test("refresh issues a fresh token for the owning live session", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const planned = await client.playback.plan({
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile,
        });
        if (planned.sessionId === null) throw new Error("Expected a session.");

        const [before] = await db
          .select({ lastSeenAt: sessionRegistry.lastSeenAt })
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, planned.sessionId));
        const refreshed = await client.playback.refresh({
          sessionId: planned.sessionId,
          itemId: fx.item.id,
        });
        expect(refreshed).toMatchObject({
          method: "direct-play",
          itemId: fx.item.id,
          versionId: fx.version.id,
          sessionId: planned.sessionId,
        });
        if (refreshed.url === null) throw new Error("Expected a URL.");
        const token = new URL(refreshed.url, base).searchParams.get("token");
        if (token === null) throw new Error("Missing playback token.");
        const claims = await verifyPlaybackToken(db, token, {
          sessionId: planned.sessionId,
          itemId: fx.item.id,
        });
        expect(claims.userId).toBe(fx.owner.id);

        const earlier = await issuePlaybackToken(
          db,
          fx.keyCaller,
          { sessionId: planned.sessionId, itemId: fx.item.id },
          Date.now() - 240_000,
        );
        const again = await client.playback.refresh({
          sessionId: planned.sessionId,
          itemId: fx.item.id,
        });
        if (again.url === null) throw new Error("Expected a URL.");
        const fresh = new URL(again.url, base).searchParams.get("token");
        if (fresh === null) throw new Error("Missing playback token.");
        const oldClaims = await verifyPlaybackToken(db, earlier.token, {
          sessionId: planned.sessionId,
          itemId: fx.item.id,
        });
        const newClaims = await verifyPlaybackToken(db, fresh, {
          sessionId: planned.sessionId,
          itemId: fx.item.id,
        });
        expect(newClaims.exp).toBeGreaterThanOrEqual(oldClaims.exp + 239);

        const [after] = await db
          .select({ lastSeenAt: sessionRegistry.lastSeenAt })
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, planned.sessionId));
        expect(after?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(
          before?.lastSeenAt?.getTime() ?? 0,
        );

        const rest = await fetch(
          `${base}/api/playback/${planned.sessionId}/${fx.item.id}/refresh`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${fx.keyToken}`,
              "content-type": "application/json",
            },
            body: "{}",
          },
        );
        expect(rest.status).toBe(200);
        const body = (await rest.json()) as { url: string | null };
        expect(body.url).toContain(
          `/api/playback/${planned.sessionId}/${fx.item.id}/direct?token=`,
        );
      } finally {
        await server.stop();
      }
    }));

  test("refresh returns the master URL for a remux session", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      await alignTimeline(db, fx.version);
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const planned = await client.playback.plan({
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile: { ...profile, containers: ["mkv"] },
        });
        if (planned.sessionId === null) throw new Error("Expected a session.");
        const refreshed = await client.playback.refresh({
          sessionId: planned.sessionId,
          itemId: fx.item.id,
        });
        expect(refreshed).toMatchObject({
          method: "remux",
          itemId: fx.item.id,
          versionId: fx.version.id,
          sessionId: planned.sessionId,
        });
        expect(refreshed.expiresAt).not.toBeNull();
        expect(refreshed.url).toContain(
          `/api/playback/${planned.sessionId}/${fx.item.id}/hls/master.m3u8?token=`,
        );
      } finally {
        await server.stop();
      }
    }));

  test("refresh rejects foreign and stopped sessions and serves remux", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const other = await createLocalUser(db, fx.admin.id, {
        username: "other",
        password: "other-pass",
      });
      const { token: otherToken } = await createApiKey(db, other.id, "other");
      const planned = await planPlayback(
        db,
        fx.keyCaller,
        { itemId: fx.item.id, versionId: fx.version.id, profile },
        { request: planRequest(), peerAddress: "127.0.0.1" },
      );
      if (planned.sessionId === null) throw new Error("Expected a session.");
      const [remuxSession] = await db
        .insert(sessionRegistry)
        .values({
          userId: fx.owner.id,
          itemId: fx.item.id,
          versionId: fx.version.id,
          playMethod: "remux",
          state: "playing",
        })
        .returning();
      if (!remuxSession) throw new Error("Session insert returned no row.");
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const foreign = await capture(
          rpcClient(base, otherToken).playback.refresh({
            sessionId: planned.sessionId,
            itemId: fx.item.id,
          }),
        );
        expect(foreign.status).toBe(401);
        const remuxed = await rpcClient(base, fx.keyToken).playback.refresh({
          sessionId: remuxSession.id,
          itemId: fx.item.id,
        });
        expect(remuxed.method).toBe("remux");
        expect(remuxed.url).toContain(
          `/api/playback/${remuxSession.id}/${fx.item.id}/hls/master.m3u8?token=`,
        );
        await db
          .update(sessionRegistry)
          .set({ state: "stopped" })
          .where(eq(sessionRegistry.id, planned.sessionId));
        const stopped = await capture(
          rpcClient(base, fx.keyToken).playback.refresh({
            sessionId: planned.sessionId,
            itemId: fx.item.id,
          }),
        );
        expect(stopped.status).toBe(401);
      } finally {
        await server.stop();
      }
      await db
        .update(sessionRegistry)
        .set({ state: "playing" })
        .where(eq(sessionRegistry.id, planned.sessionId));
      await db.insert(libraryAccess).values({
        libraryId: fx.library.id,
        userId: fx.owner.id,
        allowed: false,
      });
      await expect(
        refreshPlayback(
          db,
          fx.keyCaller,
          { sessionId: planned.sessionId, itemId: fx.item.id },
          { request: planRequest(), peerAddress: "127.0.0.1" },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("forwarded identity and persisted caps steer the WAN decision", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      // A transcode plan opens an HLS session, which needs a timeline.
      await alignTimeline(db, fx.version);
      const input = {
        itemId: fx.item.id,
        versionId: fx.version.id,
        profile,
      };
      await db.insert(settings).values({
        key: "playback",
        value: { bitrateCapBps: 4_000_000 },
      });
      await db.insert(settings).values({
        key: "auth",
        value: { trustedProxyAddresses: ["10.0.0.1"] },
      });

      const spoofed = await planPlayback(db, fx.keyCaller, input, {
        request: planRequest("192.168.1.5"),
        peerAddress: "203.0.113.8",
      });
      expect(spoofed.method).toBe("transcode");

      const forwardedWan = await planPlayback(db, fx.keyCaller, input, {
        request: planRequest("203.0.113.9"),
        peerAddress: "10.0.0.1",
      });
      expect(forwardedWan.method).toBe("transcode");
      const forwardedLan = await planPlayback(db, fx.keyCaller, input, {
        request: planRequest("192.168.1.5"),
        peerAddress: "10.0.0.1",
      });
      expect(forwardedLan.method).toBe("direct-play");
      if (forwardedLan.sessionId === null || forwardedLan.url === null)
        throw new Error("Expected a session and URL.");
      const token = new URL(
        forwardedLan.url,
        "http://thalia.test",
      ).searchParams.get("token");
      if (token === null) throw new Error("Missing playback token.");
      await verifyPlaybackToken(db, token, {
        sessionId: forwardedLan.sessionId,
        itemId: fx.item.id,
      });

      const clientCapped = await planPlayback(
        db,
        fx.keyCaller,
        { ...input, profile: { ...profile, maxBitrate: 3_000_000 } },
        { request: planRequest(), peerAddress: "127.0.0.1" },
      );
      expect(clientCapped.method).toBe("transcode");

      await db
        .update(settings)
        .set({ value: { bitrateCapBps: 20_000_000 } })
        .where(eq(settings.key, "playback"));
      await db.insert(userSettings).values({
        userId: fx.owner.id,
        bitrateCapBps: 4_000_000n,
      });
      const lowestWins = await planPlayback(
        db,
        fx.keyCaller,
        { ...input, bitrateCapBps: 15_000_000 },
        { request: planRequest(), peerAddress: "203.0.113.8" },
      );
      expect(lowestWins.method).toBe("transcode");
    }));

  test("invalid stored user cap fails closed and a lone session cap undercuts WAN", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      // A transcode plan opens an HLS session, which needs a timeline.
      await alignTimeline(db, fx.version);
      const input = {
        itemId: fx.item.id,
        versionId: fx.version.id,
        profile,
      };
      await db.insert(userSettings).values({
        userId: fx.owner.id,
        bitrateCapBps: 9_007_199_254_740_993n,
      });
      await expect(
        planPlayback(db, fx.keyCaller, input, {
          request: planRequest(),
          peerAddress: "203.0.113.8",
        }),
      ).rejects.toThrow("Invalid playback settings.");

      await db
        .update(userSettings)
        .set({ bitrateCapBps: 8_000_000n })
        .where(eq(userSettings.userId, fx.owner.id));
      await db.insert(settings).values({
        key: "playback",
        value: { bitrateCapBps: 20_000_000 },
      });
      const planned = await planPlayback(
        db,
        fx.keyCaller,
        { ...input, bitrateCapBps: 3_000_000 },
        { request: planRequest(), peerAddress: "203.0.113.8" },
      );
      expect(planned.method).toBe("transcode");
      if (planned.sessionId === null) throw new Error("Expected a session.");
      const [row] = await db
        .select({ decision: sessionRegistry.decision })
        .from(sessionRegistry)
        .where(eq(sessionRegistry.id, planned.sessionId));
      expect(row?.decision).toMatchObject({
        video: { action: "transcode", bitrate: 2_000_000 },
      });
    }));

  test("dts-hd audio, srt subtitles and attached pictures normalise for direct play", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db, "owner", {
        audioCodec: "dts",
        audioProfile: "dtshdma",
        audioChannels: 6,
        attachedPicture: true,
      });
      const planned = await planPlayback(
        db,
        fx.keyCaller,
        {
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile: {
            ...profile,
            audioCodecs: [{ codec: "dts-hd", maxChannels: 8 }],
          },
        },
        { request: planRequest(), peerAddress: "127.0.0.1" },
      );
      expect(planned.method).toBe("direct-play");
      expect(planned.sessionId).not.toBeNull();
    }));

  test("a changed global cap applies to the next plan", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      // A transcode plan opens an HLS session, which needs a timeline.
      await alignTimeline(db, fx.version);
      const input = { itemId: fx.item.id, versionId: fx.version.id, profile };
      const wan = { request: planRequest(), peerAddress: "203.0.113.8" };
      expect((await planPlayback(db, fx.keyCaller, input, wan)).method).toBe(
        "direct-play",
      );
      // The 5 Mbit/s source no longer fits under 3 Mbit/s.
      await writeGlobalBitrateCap(db, fx.admin.id, 3_000_000);
      expect((await planPlayback(db, fx.keyCaller, input, wan)).method).toBe(
        "transcode",
      );
      await writeGlobalBitrateCap(db, fx.admin.id, null);
      expect((await planPlayback(db, fx.keyCaller, input, wan)).method).toBe(
        "direct-play",
      );
    }));

  test("live plans read the CPU 4K opt-in and probed frame rate", () =>
    withDatabase(async (db) => {
      const fx = await seedPlayback(db);
      await db
        .update(streams)
        .set({
          codec: "hevc",
          profile: "main10",
          width: 3840,
          height: 2160,
          hdr: "hdr10",
          bitrate: 40_000_000n,
          frameRateNumerator: 24000,
          frameRateDenominator: 1001,
        })
        .where(eq(streams.index, 0));
      const input = {
        itemId: fx.item.id,
        versionId: fx.version.id,
        profile: {
          ...profile,
          progressive: true,
          videoCodecs: [{ codec: "h264" }],
        },
      };
      const transport = { request: planRequest(), peerAddress: "203.0.113.8" };
      const planVideo = async () => {
        const planned = await planPlayback(db, fx.keyCaller, input, transport);
        const [session] = await db
          .select({ decision: sessionRegistry.decision })
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, planned.sessionId));
        const decision = session?.decision;
        if (!decision || decision.method === "stored")
          throw new Error("Expected a live plan.");
        return decision.video;
      };
      expect(await planVideo()).toMatchObject({
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
      });
      await writePlaybackSettings(db, fx.admin.id, { allowCpu4k: true });
      expect(await planVideo()).toMatchObject({
        width: 3840,
        height: 2160,
        bitrate: 25_000_000,
      });
      await writePlaybackSettings(db, fx.admin.id, { allowCpu4k: false });
      await db
        .update(streams)
        .set({ frameRateNumerator: 60000 })
        .where(eq(streams.index, 0));
      expect(await planVideo()).toMatchObject({
        width: 1920,
        height: 1080,
        bitrate: 12_000_000,
      });
    }));

  test("a planned session records its client and announces itself", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const input = { itemId: fx.item.id, versionId: fx.version.id, profile };
      const transport = { request: planRequest(), peerAddress: "127.0.0.1" };
      const bySession = await planPlayback(db, fx.caller, input, transport);
      const byKey = await planPlayback(db, fx.keyCaller, input, transport);
      const clientOf = async (sessionId: string | null) => {
        if (sessionId === null) throw new Error("Expected a session.");
        const [row] = await db
          .select({
            clientName: sessionRegistry.clientName,
            deviceName: sessionRegistry.deviceName,
          })
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, sessionId));
        return row;
      };
      expect(await clientOf(bySession.sessionId)).toEqual({
        clientName: "Test Client",
        deviceName: "Living Room",
      });
      expect(await clientOf(byKey.sessionId)).toEqual({
        clientName: "player",
        deviceName: null,
      });
      const announced = await db
        .select({ payload: events.payload })
        .from(events)
        .where(eq(events.kind, "session.state"))
        .orderBy(events.id);
      expect(announced.map((row) => row.payload)).toEqual([
        {
          kind: "session.state",
          sessionId: bySession.sessionId,
          state: "starting",
        },
        {
          kind: "session.state",
          sessionId: byKey.sessionId,
          state: "starting",
        },
      ]);
    }));

  test("a 720p quality pick on LAN transcodes at the rung and reports the menu's rungs", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      // A transcode plan opens an HLS session, which needs a timeline.
      await alignTimeline(db, fx.version);
      const planned = await planPlayback(
        db,
        fx.keyCaller,
        {
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile,
          quality: "720p",
        },
        { request: planRequest(), peerAddress: "192.168.1.5" },
      );
      expect(planned.method).toBe("transcode");
      if (planned.sessionId === null) throw new Error("Expected a session.");
      const [row] = await db
        .select({ decision: sessionRegistry.decision })
        .from(sessionRegistry)
        .where(eq(sessionRegistry.id, planned.sessionId));
      expect(row?.decision).toMatchObject({
        video: {
          action: "transcode",
          height: 720,
          rung: { height: 720 },
        },
      });
      expect(planned.quality.original?.name).toBe("1080p");
      expect(planned.quality.rungs.map((rung) => rung.name)).toEqual([
        "720p",
        "480p",
      ]);
    }));
});

describe.skipIf(!databaseUrl)("api playback progressive", () => {
  const jobsOf = (db: Database) =>
    db.select().from(jobs).where(eq(jobs.type, "keyframe-index"));

  test("an unindexed MKV plans a progressive stream when the profile accepts it", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db, "owner", { container: "mkv" });
      const planned = await planPlayback(
        db,
        fx.keyCaller,
        {
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile: { ...profile, progressive: true },
          subtitleStreamIndex: 2,
        },
        { request: planRequest(), peerAddress: "127.0.0.1" },
      );
      expect(planned.method).toBe("remux");
      expect(planned.delivery).toBe("progressive");
      expect(planned.url).toMatch(/\/stream\?token=/);
      expect(planned.output).toEqual({
        video: { codec: "h264", profile: "high", transcode: false },
        audio: { codec: "aac" },
      });
      // The chosen text subtitle is served as WebVTT beside the stream.
      expect(planned.subtitleUrl).toMatch(/\/subtitles\/2\.vtt\?token=/);
      const [registry] = await db
        .select()
        .from(sessionRegistry)
        .where(eq(sessionRegistry.id, planned.sessionId ?? ""));
      expect(registry?.decision?.delivery).toBe("progressive");
    }));

  test("a bitmap subtitle stays burned in with no subtitle URL", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db, "owner", {
        container: "mkv",
        subtitleCodec: "hdmv_pgs_subtitle",
      });
      const planned = await planPlayback(
        db,
        fx.keyCaller,
        {
          itemId: fx.item.id,
          versionId: fx.version.id,
          // h264 not accepted → video transcodes and burns the subtitle
          profile: {
            ...profile,
            videoCodecs: [{ codec: "av1" }],
            subtitleFormats: ["webvtt"],
            progressive: true,
          },
          subtitleStreamIndex: 2,
        },
        { request: planRequest(), peerAddress: "127.0.0.1" },
      );
      expect(planned.method).toBe("transcode");
      expect(planned.output?.video.transcode).toBe(true);
      expect(planned.subtitleUrl).toBeNull();
    }));

  test("an unindexed Version without progressive throws PREPARING and queues one top-priority index job", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db, "owner", { container: "mkv" });
      const plan = () =>
        planPlayback(
          db,
          fx.keyCaller,
          {
            itemId: fx.item.id,
            versionId: fx.version.id,
            profile, // no progressive
          },
          { request: planRequest(), peerAddress: "127.0.0.1" },
        );
      await expect(plan()).rejects.toMatchObject({ code: "PREPARING" });
      const queued = await jobsOf(db);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.priority).toBe(10);
      expect(queued[0]?.payload).toMatchObject({
        rootId: expect.any(String),
        path: fx.file.path,
      });
      // Planning again raises no duplicate.
      await expect(plan()).rejects.toMatchObject({ code: "PREPARING" });
      expect(await jobsOf(db)).toHaveLength(1);
      // A low-priority backlog job is raised, not duplicated.
      await db
        .update(jobs)
        .set({ priority: -5 })
        .where(eq(jobs.id, queued[0]?.id ?? ""));
      await expect(plan()).rejects.toMatchObject({ code: "PREPARING" });
      const after = await jobsOf(db);
      expect(after).toHaveLength(1);
      expect(after[0]?.priority).toBe(10);
    }));

  test("an indexed but unaligned Version still refuses with CONFLICT", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db, "owner", { container: "mkv" });
      await db
        .update(versions)
        .set({ lazyIndexPending: false })
        .where(eq(versions.id, fx.version.id));
      await expect(
        planPlayback(
          db,
          fx.keyCaller,
          {
            itemId: fx.item.id,
            versionId: fx.version.id,
            profile,
          },
          { request: planRequest(), peerAddress: "127.0.0.1" },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await jobsOf(db)).toHaveLength(0);
    }));

  test("direct play reports no delivery", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const planned = await planPlayback(
        db,
        fx.keyCaller,
        {
          itemId: fx.item.id,
          versionId: fx.version.id,
          profile,
        },
        { request: planRequest(), peerAddress: "127.0.0.1" },
      );
      expect(planned.method).toBe("direct-play");
      expect(planned.delivery).toBeNull();
      expect(planned.output).toBeNull();
      expect(planned.subtitleUrl).toBeNull();
    }));
});
