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
  progress,
  segmentTimelines,
  sessionRegistry,
  transcoderCapabilities,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { decidePlayback } from "../playback/decisions.ts";
import { listPlaybackSessions, transcodeReasons } from "./playback-sessions.ts";
import type { thaliaRouter } from "./router.ts";

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
      storedFolder: "alien/alien.mkv.thalia/360p",
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

// An h264+aac mp4 for a client that takes it all plays directly.
const directDecision = decidePlayback(
  {
    container: "mp4",
    video: {
      codec: "h264",
      width: 1920,
      height: 1080,
      bitrate: 6_000_000,
      hdr: "sdr",
    },
    audio: [{ codec: "aac", channels: 2 }],
    subtitles: [{ format: "srt", kind: "text" }],
  },
  {
    containers: ["mp4"],
    videoCodecs: [{ codec: "h264" }],
    audioCodecs: [{ codec: "aac", maxChannels: 2 }],
    subtitleFormats: ["srt"],
    hdr: ["sdr"],
  },
  { isLan: true },
);

// Six-channel AC3 on an AAC-stereo-only client re-encodes audio while the h264 video copies.
const audioOnlyDecision = decidePlayback(
  {
    container: "mkv",
    video: {
      codec: "h264",
      width: 1920,
      height: 1080,
      bitrate: 6_000_000,
      hdr: "sdr",
    },
    audio: [{ codec: "ac3", channels: 6 }],
    subtitles: [],
  },
  {
    containers: ["mp4"],
    videoCodecs: [{ codec: "h264" }],
    audioCodecs: [{ codec: "aac", maxChannels: 2 }],
    subtitleFormats: [],
    hdr: ["sdr"],
  },
  { isLan: true },
);

// A bitmap subtitle the client cannot draw burns into a video transcode.
const burnDecision = decidePlayback(
  {
    container: "mkv",
    video: {
      codec: "h264",
      width: 1920,
      height: 1080,
      bitrate: 6_000_000,
      hdr: "sdr",
    },
    audio: [{ codec: "aac", channels: 2 }],
    subtitles: [{ format: "pgs", kind: "bitmap" }],
    selection: { subtitle: 0 },
  },
  {
    containers: ["mkv"],
    videoCodecs: [{ codec: "h264" }],
    audioCodecs: [{ codec: "aac", maxChannels: 2 }],
    subtitleFormats: ["srt"],
    hdr: ["sdr"],
  },
  { isLan: true },
);

// HDR10 HEVC with a bitmap subtitle on an SDR H.264 client tone maps and burns in one transcode; its aac audio copies.
const hdrBurnDecision = decidePlayback(
  {
    container: "mkv",
    video: {
      codec: "hevc",
      width: 3840,
      height: 2160,
      bitrate: 20_000_000,
      hdr: "hdr10",
    },
    audio: [{ codec: "aac", channels: 2 }],
    subtitles: [{ format: "pgs", kind: "bitmap" }],
    selection: { subtitle: 0 },
  },
  {
    containers: ["mkv"],
    videoCodecs: [{ codec: "h264" }],
    audioCodecs: [{ codec: "aac", maxChannels: 2 }],
    subtitleFormats: ["srt"],
    hdr: ["sdr"],
  },
  { isLan: true },
);

describe("transcodeReasons", () => {
  test("direct play, remux and stored Versions convert nothing", () => {
    expect(directDecision.method).toBe("direct-play");
    expect(transcodeReasons(directDecision)).toEqual([]);
    expect(transcodeReasons(null)).toEqual([]);
    expect(
      transcodeReasons({
        method: "stored",
        selection: { audio: 0 },
      }),
    ).toEqual([]);
  });

  test("an audio-only transcode converts audio", () => {
    expect(audioOnlyDecision.method).toBe("transcode");
    expect(audioOnlyDecision.video.action).toBe("copy");
    expect(transcodeReasons(audioOnlyDecision)).toEqual(["audio"]);
  });

  test("a video transcode names video first, audio last", () => {
    expect(transcodeDecision.method).toBe("transcode");
    expect(transcodeReasons(transcodeDecision)).toEqual(["video"]);
  });

  test("a burned-in bitmap subtitle names subtitles", () => {
    expect(burnDecision.method).toBe("transcode");
    expect(transcodeReasons(burnDecision)).toContain("subtitles");
  });

  test("tone mapping and burn-in name hdr and subtitles together", () => {
    expect(hdrBurnDecision.method).toBe("transcode");
    if (hdrBurnDecision.method !== "transcode") return;
    expect(hdrBurnDecision.video.action).toBe("transcode");
    if (hdrBurnDecision.video.action !== "transcode") return;
    expect(hdrBurnDecision.video.toneMap).not.toBeNull();
    expect(hdrBurnDecision.video.burnSubtitles).toBe(true);
    expect(transcodeReasons(hdrBurnDecision)).toEqual(["subtitles", "hdr"]);
  });
});

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
        clientName: "Thalia Web",
        deviceName: "Firefox",
      });
      const stored = await fx.open({
        playMethod: "remux",
        state: "starting",
        clientName: "player",
        decision: {
          method: "stored",
          selection: { audio: 0 },
          storedVariantIds: [fx.stored.id],
        },
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
        clientName: "Thalia Web",
        deviceName: "Firefox",
        item: { id: fx.item.id, title: "Alien", kind: "movie" },
        version: {
          id: fx.version.id,
          label: "Original",
          durationSeconds: null,
        },
        positionSeconds: null,
        reasons: [],
        rungs: ["source"],
      });
      expect(listed[0]?.reasons).toEqual(["video"]);
      expect(listed[1]?.reasons).toEqual([]);

      await db.insert(progress).values({
        userId: fx.viewer.id,
        itemId: fx.item.id,
        versionId: fx.version.id,
        format: "video",
        positionSeconds: 42.5,
      });
      const [updated] = (await listPlaybackSessions(db, fx.admin.id)).filter(
        (session) => session.id === direct.id,
      );
      expect(updated?.positionSeconds).toBe(42.5);

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
      const server = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = (token: string) =>
          createORPCClient<RouterClient<typeof thaliaRouter>>(
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
