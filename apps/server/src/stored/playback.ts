import { resolve } from "node:path";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  libraries,
  segmentTimelines,
  streams,
  versions,
} from "../db/schema/index.ts";
import {
  type PlaybackVersion,
  selectAdaptiveGroup,
} from "../playback/adaptive.ts";
import type { PlaybackDecision } from "../playback/decisions.ts";
import { standardHeaders } from "../playback/direct.ts";
import { isHdr } from "../playback/planning.ts";
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  type HlsName,
  type PlaylistVariant,
  segmentCount,
  variantCodecs,
} from "../playback/playlists.ts";
import type { ClientProfile, PlaybackCaps } from "../playback/policy.ts";
import { sourceRungName } from "./policy.ts";

type StreamRow = typeof streams.$inferSelect;

/** Loads the complete stored Versions of an Item on one timeline, with their video and first audio Stream. */
async function loadStored(db: Database, where: SQL | undefined) {
  const rows = await db
    .select({ version: versions, timeline: segmentTimelines })
    .from(versions)
    .innerJoin(
      segmentTimelines,
      eq(segmentTimelines.id, versions.segmentTimelineId),
    )
    .where(
      and(eq(versions.origin, "stored"), eq(versions.complete, true), where),
    );
  const streamRows =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(streams)
          .where(
            inArray(
              streams.versionId,
              rows.map((row) => row.version.id),
            ),
          )
          .orderBy(asc(streams.index));
  return rows.flatMap(({ version, timeline }) => {
    const own = streamRows.filter((stream) => stream.versionId === version.id);
    const video = own.find((stream) => stream.kind === "video");
    const audio = own.find((stream) => stream.kind === "audio");
    if (
      video?.width == null ||
      video.height == null ||
      video.bitrate === null ||
      !isHdr(video.hdr)
    )
      return [];
    return [
      {
        version,
        timeline,
        video: {
          ...video,
          width: video.width,
          height: video.height,
          bitrate: video.bitrate,
          hdr: video.hdr,
        },
        audio,
      },
    ];
  });
}

const accepts = (client: ClientProfile, audio: StreamRow | undefined) =>
  audio === undefined ||
  client.audioCodecs.some(
    (candidate) =>
      candidate.codec === audio.codec &&
      candidate.maxChannels >= (audio.channels ?? Infinity),
  );

/** Picks the stored rungs a client gets instead of a live session; empty when the live path should run. */
export async function selectStoredVariants(
  db: Database,
  source: {
    itemId: string;
    fileId: string;
    segmentTimelineId: string | null;
    decision: PlaybackDecision;
  },
  client: ClientProfile,
  caps: PlaybackCaps,
) {
  if (
    source.decision.method === "direct-play" ||
    source.segmentTimelineId === null
  )
    return [];
  // Only rungs of the played File: another Version may be another
  // translation or release on the same timeline. A trigger keeps their
  // timeline equal to the source's.
  const stored = await loadStored(
    db,
    and(
      eq(versions.itemId, source.itemId),
      eq(versions.sourceFileId, source.fileId),
    ),
  );
  const [first] = stored;
  if (first === undefined) return [];
  const candidates = stored.filter((row) => accepts(client, row.audio));
  const group = selectAdaptiveGroup(
    candidates.map(
      ({ version, video }): PlaybackVersion => ({
        id: version.id,
        itemId: version.itemId,
        segmentTimelineId: version.segmentTimelineId,
        durationSeconds: version.durationSeconds ?? -1,
        video: { ...video, bitrate: Number(video.bitrate) },
        origin: "stored",
        complete: version.complete === true,
        timelineAligned: version.timelineAligned,
      }),
    ),
    first.timeline,
    client,
    caps,
  );
  const variants = group.variants.map((variant) => variant.id);
  // A remux already plays the source untouched; stored rungs replace it only
  // when they include that source, so quality never drops to save nothing.
  if (source.decision.method === "remux") {
    const keepsSource = stored.some(
      (row) =>
        variants.includes(row.version.id) &&
        row.version.rung === sourceRungName,
    );
    if (!keepsSource) return [];
  }
  return variants;
}

const playlist = (body: string) =>
  new Response(body, {
    headers: {
      ...standardHeaders,
      "content-type": "application/vnd.apple.mpegurl",
    },
  });

const notFound = () =>
  Response.json(
    { error: { code: "NOT_FOUND", message: "Not found." } },
    { status: 404, headers: standardHeaders },
  );

/** Serves a stored session from disk: the master over its variants, and each variant's playlist, init and segments. */
export async function serveStoredHls(
  db: Database,
  session: { itemId: string; variantIds: readonly string[] },
  variantId: string | null,
  name: HlsName,
  query: string,
) {
  if (variantId === null) {
    if (name.kind !== "master") return notFound();
    const stored = await loadStored(
      db,
      and(
        eq(versions.itemId, session.itemId),
        inArray(versions.id, [...session.variantIds]),
      ),
    );
    const variants = stored
      .toSorted((a, b) => Number(a.video.bitrate - b.video.bitrate))
      .map(
        ({ version, video, audio }): PlaylistVariant => ({
          uri: `${version.id}/media.m3u8`,
          bandwidth: Number(video.bitrate + (audio?.bitrate ?? 0n)),
          width: video.width,
          height: video.height,
          codecs: variantCodecs(video, audio),
        }),
      );
    if (variants.length === 0) return notFound();
    return playlist(buildMasterPlaylist(variants, query));
  }
  if (!session.variantIds.includes(variantId) || name.kind === "master")
    return notFound();
  const [row] = await db
    .select({
      storedFolder: versions.storedFolder,
      rootPath: libraries.rootPath,
      boundariesSeconds: segmentTimelines.boundariesSeconds,
    })
    .from(versions)
    .innerJoin(libraries, eq(libraries.id, versions.libraryId))
    .innerJoin(
      segmentTimelines,
      eq(segmentTimelines.id, versions.segmentTimelineId),
    )
    .where(
      and(
        eq(versions.id, variantId),
        eq(versions.itemId, session.itemId),
        eq(versions.complete, true),
      ),
    )
    .limit(1);
  if (row === undefined || row.storedFolder === null) return notFound();
  if (name.kind === "media")
    return playlist(buildMediaPlaylist(row.boundariesSeconds, query));
  if (
    name.kind === "segment" &&
    name.index >= segmentCount(row.boundariesSeconds)
  )
    return notFound();
  const file = Bun.file(
    resolve(
      row.rootPath,
      row.storedFolder,
      name.kind === "init" ? "init.mp4" : `${name.index}.m4s`,
    ),
  );
  if (!(await file.exists())) return notFound();
  return new Response(file, {
    headers: {
      ...standardHeaders,
      "content-type": name.kind === "init" ? "video/mp4" : "video/iso.segment",
    },
  });
}
