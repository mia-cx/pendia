import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  items,
  segmentTimelines,
  sessionRegistry,
  transcoderCapabilities,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { decidePlayback } from "../playback/decisions.ts";
import { listPlaybackSessions } from "./playback-sessions.ts";
import type { pendiaRouter } from "./router.ts";

async function seed(db: Database) {
  const admin = await setupAdmin(db, { username: "admin", password: "secret" });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
    displayName: "Viewer",
  });
  const [library] = await insertLibraries(db, {
    name: "Movies",
    medium: "movies",
    rootPath: "/srv/movies",
  });
  if (!library) throw new Error("Library insert returned no row.");
  const [item] = await db
    .insert(items)
    .values({
      libraryId: library.id,
      kind: "movie",
      title: "Alien",
      canonicalFolder: "/srv/movies/alien",
    })
    .returning();
  if (!item) throw new Error("Item insert returned no row.");
  const [timeline] = await db
    .insert(segmentTimelines)
    .values({ itemId: item.id, cutKey: "original", boundariesSeconds: [0, 4] })
    .returning();
  if (!timeline) throw new Error("Timeline insert returned no row.");
  const [version] = await db
    .insert(versions)
    .values({
      itemId: item.id,
      itemKind: "movie",
      libraryId: library.id,
      label: "Original",
      format: "video",
      bytes: 1n,
      segmentTimelineId: timeline.id,
      timelineAligned: true,
    })
    .returning();
  if (!version) throw new Error("Version insert returned no row.");
  const [file] = await db
    .insert(files)
    .values({
      versionId: version.id,
      itemId: item.id,
      libraryId: library.id,
      rootId: library.rootId,
      path: "/srv/movies/alien/alien.mkv",
      order: 0,
      bytes: 1n,
      modifiedAt: new Date(),
    })
    .returning();
  if (!file) throw new Error("File insert returned no row.");
  const [stored] = await db
    .insert(versions)
    .values({
      itemId: item.id,
      itemKind: "movie",
      libraryId: library.id,
      label: "360p",
      format: "video",
      bytes: 1n,
      origin: "stored",
      sourceFileId: file.id,
      storedFolder: "alien/alien.mkv.pendia/360p",
      rung: "360p",
      complete: true,
      segmentTimelineId: timeline.id,
      timelineAligned: true,
    })
    .returning();
  if (!stored) throw new Error("Stored Version insert returned no row.");
  const open = async (values: Partial<typeof sessionRegistry.$inferInsert>) => {
    const [row] = await db
      .insert(sessionRegistry)
      .values({
        userId: viewer.id,
        itemId: item.id,
        versionId: version.id,
        playMethod: "direct-play",
        state: "playing",
        ...values,
      })
      .returning();
    if (!row) throw new Error("Session insert returned no row.");
    return row;
  };
  return { admin, viewer, item, version, stored, open };
}

// An HEVC source for an H.264-only client re-encodes to a ladder rung.
const transcodeDecision = decidePlayback(
  {
    container: "mkv",
    video: {
      codec: "hevc",
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      hdr: "sdr",
    },
    audio: [{ codec: "aac", channels: 2 }],
    subtitles: [],
  },
  {
    containers: ["mp4"],
    videoCodecs: [{ codec: "h264", maxHeight: 720 }],
    audioCodecs: [{ codec: "aac", maxChannels: 2 }],
    subtitleFormats: [],
    hdr: ["sdr"],
  },
  { isLan: true },
);

describe.skipIf(!databaseUrl)("playback sessions", () => {
  test("lists live and queued sessions with client, Item, rung and transcoder", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const [node] = await db
        .insert(transcoderCapabilities)
        .values({
          name: "transcoder-a",
          address: "http://10.0.0.2:3001",
          testedAt: new Date(),
          backends: [],
        })
        .returning();
      if (!node) throw new Error("Node insert returned no row.");
      const direct = await fx.open({
        clientName: "Pendia Web",
        deviceName: "Firefox",
      });
      const stored = await fx.open({
        playMethod: "remux",
        state: "starting",
        clientName: "player",
        decision: { method: "stored", storedVariantIds: [fx.stored.id] },
      });
      const live = await fx.open({
        playMethod: "transcode",
        state: "queued",
        transcoderNodeId: node.id,
        decision: transcodeDecision,
      });
      await fx.open({ state: "stopped" });
      await fx.open({
        lastSeenAt: new Date(Date.now() - 6 * 60_000),
      });

      const listed = await listPlaybackSessions(db, fx.admin.id);
      expect(listed.map((session) => session.id)).toEqual([
        live.id,
        stored.id,
        direct.id,
      ]);
      expect(listed[0]).toMatchObject({
        state: "queued",
        playMethod: "transcode",
        rungs: ["720p"],
        transcoder: "transcoder-a",
      });
      expect(listed[1]).toMatchObject({
        state: "starting",
        playMethod: "remux",
        clientName: "player",
        deviceName: null,
        rungs: ["360p"],
        transcoder: null,
      });
      expect(listed[2]).toMatchObject({
        state: "playing",
        playMethod: "direct-play",
        user: { id: fx.viewer.id, displayName: "Viewer" },
        clientName: "Pendia Web",
        deviceName: "Firefox",
        item: { id: fx.item.id, title: "Alien", kind: "movie" },
        rungs: ["source"],
      });

      await db
        .update(sessionRegistry)
        .set({ state: "stopped" })
        .where(eq(sessionRegistry.id, live.id));
      expect(
        (await listPlaybackSessions(db, fx.admin.id)).map(
          (session) => session.id,
        ),
      ).toEqual([stored.id, direct.id]);
    }));

  test("needs manage-server, over RPC and REST", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      await expect(
        listPlaybackSessions(db, fx.viewer.id),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const { token: adminToken } = await createApiKey(db, fx.admin.id, "a");
      const { token: viewerToken } = await createApiKey(db, fx.viewer.id, "v");
      await fx.open({});
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = (token: string) =>
          createORPCClient<RouterClient<typeof pendiaRouter>>(
            new RPCLink({
              url: `${base}/rpc`,
              headers: { authorization: `Bearer ${token}` },
            }),
          );
        expect(await client(adminToken).playback.sessions()).toHaveLength(1);
        const denied = await client(viewerToken)
          .playback.sessions()
          .catch((error: unknown) => error);
        if (!(denied instanceof ORPCError))
          throw new Error("Expected a denial.");
        expect(denied.status).toBe(403);
        const rest = await fetch(`${base}/api/playback/sessions`, {
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(rest.status).toBe(200);
        expect(await rest.json()).toHaveLength(1);
      } finally {
        await server.stop();
      }
    }));
});
