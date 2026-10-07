import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  files,
  segmentTimelines,
  streams,
  versions,
} from "../db/schema/index.ts";
import { locateFile } from "../libraries/roots.ts";
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
  type SubtitleRendition,
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

/** Loads the complete stored Versions derived from one File, with their video and first audio Stream. */
export async function loadStoredCandidates(
  db: Database,
  source: { itemId: string; fileId: string },
) {
  // Only rungs of the played File: another Version may be another
  // translation or release on the same timeline. A trigger keeps their
  // timeline equal to the source's.
  return loadStored(
    db,
    and(
      eq(versions.itemId, source.itemId),
      eq(versions.sourceFileId, source.fileId),
    ),
  );
}

type StoredCandidates = Awaited<ReturnType<typeof loadStoredCandidates>>;

/** Picks the stored rungs among loaded candidates a client gets; empty when the live path should run. A null live method means no live path exists. */
export function pickStoredVariants(
  stored: StoredCandidates,
  source: {
    segmentTimelineId: string | null;
    liveMethod: PlaybackDecision["method"] | null;
  },
  client: ClientProfile,
  caps: PlaybackCaps,
): { variantIds: string[]; bitrate: number | null } {
  const none = { variantIds: [], bitrate: null };
  if (source.liveMethod === "direct-play" || source.segmentTimelineId === null)
    return none;
  const [first] = stored;
  if (first === undefined) return none;
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
  // A remux already plays the source untouched; stored rungs replace it only
  // when they include that source, so quality never drops to save nothing.
  if (source.liveMethod === "remux") {
    const variants = group.variants.map((variant) => variant.id);
    const keepsSource = stored.some(
      (row) =>
        variants.includes(row.version.id) &&
        row.version.rung === sourceRungName,
    );
    if (!keepsSource) return none;
  }
  const bitrates = group.variants.map((variant) => variant.video.bitrate);
  return {
    variantIds: group.variants.map((variant) => variant.id),
    bitrate: bitrates.length === 0 ? null : Math.max(...bitrates),
  };
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

/** Serves a stored session from disk: the master over its variants with the session's WebVTT renditions, and each variant's playlist, init and segments. */
export async function serveStoredHls(
  db: Database,
  session: { itemId: string; variantIds: readonly string[] },
  variantId: string | null,
  name: HlsName,
  query: string,
  subtitles: readonly SubtitleRendition[] = [],
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
    return playlist(buildMasterPlaylist(variants, query, subtitles));
  }
  // Subtitles live beside the master, not inside a rung.
  if (
    !session.variantIds.includes(variantId) ||
    name.kind === "master" ||
    name.kind === "subtitles" ||
    name.kind === "subtitle"
  )
    return notFound();
  const [row] = await db
    .select({
      storedFolder: versions.storedFolder,
      rootId: files.rootId,
      boundariesSeconds: segmentTimelines.boundariesSeconds,
    })
    .from(versions)
    .innerJoin(files, eq(files.id, versions.sourceFileId))
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
  // The same no-symlink walk direct play uses keeps reads inside the library.
  let located: Awaited<ReturnType<typeof locateFile>>;
  try {
    located = await locateFile(db, {
      rootId: row.rootId,
      path: `${row.storedFolder}/${name.kind === "init" ? "init.mp4" : `${name.index}.m4s`}`,
    });
  } catch {
    return notFound();
  }
  return new Response(Bun.file(located.absolute), {
    headers: {
      ...standardHeaders,
      "content-type": name.kind === "init" ? "video/mp4" : "video/iso.segment",
    },
  });
}
