import type { VersionView } from "../api/views.ts";
import { toSubtitleStream } from "../playback/planning.ts";
import { ticksPerSecond, toGuid } from "./request.ts";

type Stream = VersionView["streams"][number];
type Method = "direct-play" | "remux" | "transcode";

/** A planned play of one Version: its method, the session query its URLs carry and its Stream selection. */
export type PlannedSource = {
  method: Method;
  /** `PlaySessionId`, `MediaSourceId`, the selection and the playback token; null when planning issued no token into a URL. */
  query: URLSearchParams | null;
  /** The audio Stream the session plays; null without audio. */
  audioStreamIndex: number | null;
  /** The subtitle Stream the client chose, null for none; undefined when it chose nothing. */
  subtitleStreamIndex?: number | null;
};

const streamTypes = {
  video: "Video",
  audio: "Audio",
  subtitle: "Subtitle",
} as const;

// Jellyfin's VideoRange and VideoRangeType for each probed HDR flavour.
const videoRanges: Record<string, readonly [string, string]> = {
  sdr: ["SDR", "SDR"],
  hdr10: ["HDR", "HDR10"],
  "hdr10+": ["HDR", "HDR10Plus"],
  hlg: ["HDR", "HLG"],
};

// Dolby Vision profile 7 adds an enhancement layer, 8 an HDR10 base layer.
const doviRangeTypes: Record<number, string> = {
  7: "DOVIWithEL",
  8: "DOVIWithHDR10",
};

function videoRange(stream: Stream): readonly [string, string] {
  if (stream.kind !== "video" || stream.hdr === null)
    return ["Unknown", "Unknown"];
  if (stream.hdr === "dolby-vision")
    return ["HDR", doviRangeTypes[stream.dvProfile ?? 0] ?? "DOVI"];
  return videoRanges[stream.hdr] ?? ["Unknown", "Unknown"];
}

const frameRate = (stream: Stream) =>
  stream.frameRateNumerator === null || !stream.frameRateDenominator
    ? undefined
    : stream.frameRateNumerator / stream.frameRateDenominator;

/** The Jellyfin route that serves one text subtitle Stream as WebVTT. */
export function subtitleUrl(
  itemId: string,
  versionId: string,
  index: number,
  query: URLSearchParams | null,
) {
  const path = `/videos/${toGuid(itemId)}/${toGuid(versionId)}/Subtitles/${index}/Stream.vtt`;
  return query === null ? path : `${path}?${query}`;
}

function mediaStream(
  itemId: string,
  versionId: string,
  stream: Stream,
  planned: PlannedSource | undefined,
) {
  const [range, rangeType] = videoRange(stream);
  const subtitle =
    stream.kind === "subtitle" ? toSubtitleStream(stream) : undefined;
  const text = subtitle?.kind === "text";
  // A direct play hands the client its own subtitles; HLS lists text tracks
  // in the master playlist and burns the bitmap one in.
  const delivery =
    subtitle === undefined || planned === undefined
      ? undefined
      : planned.method === "direct-play"
        ? "Embed"
        : text
          ? "Hls"
          : "Encode";
  const rate = frameRate(stream);
  return {
    Codec: stream.codec,
    Language: stream.language ?? undefined,
    Title: stream.title ?? undefined,
    DisplayTitle:
      [stream.title ?? stream.language, stream.codec.toUpperCase()]
        .filter((part) => part !== null)
        .join(" - ") || undefined,
    Type: streamTypes[stream.kind],
    Index: stream.index,
    Profile: stream.profile ?? undefined,
    Level: stream.level ?? undefined,
    BitRate: stream.bitrate === null ? undefined : Number(stream.bitrate),
    Width: stream.width ?? undefined,
    Height: stream.height ?? undefined,
    AverageFrameRate: rate,
    RealFrameRate: rate,
    VideoRange: range,
    VideoRangeType: rangeType,
    DvProfile: stream.dvProfile ?? undefined,
    AudioSpatialFormat: "None",
    Channels: stream.channels ?? undefined,
    ChannelLayout: stream.channelLayout ?? undefined,
    SampleRate: stream.sampleRate ?? undefined,
    IsInterlaced: false,
    IsDefault: stream.disposition.default === true,
    IsForced: stream.disposition.forced === true,
    IsHearingImpaired: stream.disposition.hearing_impaired === true,
    IsExternal: false,
    IsTextSubtitleStream: text,
    SupportsExternalStream: text,
    DeliveryMethod: delivery,
    DeliveryUrl: text
      ? subtitleUrl(itemId, versionId, stream.index, planned?.query ?? null)
      : undefined,
  };
}

/**
 * Builds a Jellyfin MediaSourceInfo for one Version. A planned source carries
 * the flags of its play method: direct play alone, remux as direct stream
 * plus transcoding, transcode alone, each HLS one with its TranscodingUrl.
 * An unplanned source, as `/Items/{id}` lists them, claims every method;
 * clients ask PlaybackInfo before they play it.
 */
export function mediaSource(
  itemId: string,
  version: VersionView,
  planned?: PlannedSource | null,
) {
  const method = planned?.method;
  const hls = method === "remux" || method === "transcode";
  const duration = version.file.durationSeconds ?? version.durationSeconds;
  const audio = version.streams.filter((stream) => stream.kind === "audio");
  const subtitles = version.streams.filter(
    (stream) => stream.kind === "subtitle",
  );
  // A planned session plays its selection; a file plays its default.
  const defaultAudio =
    planned == null
      ? (audio.find((stream) => stream.disposition.default) ?? audio[0])?.index
      : (planned.audioStreamIndex ?? undefined);
  const chosenSubtitle = planned?.subtitleStreamIndex;
  const defaultSubtitle =
    chosenSubtitle === undefined
      ? subtitles.find(
          (stream) => stream.disposition.forced || stream.disposition.default,
        )?.index
      : (chosenSubtitle ?? -1);
  const bitrates = version.streams.flatMap((stream) =>
    stream.bitrate === null ? [] : [Number(stream.bitrate)],
  );
  return {
    Protocol: "File",
    Id: toGuid(version.id),
    Type: "Default",
    Container: version.file.container ?? undefined,
    Size: Number(version.file.bytes),
    Name: version.label,
    IsRemote: false,
    ETag: toGuid(version.file.id),
    RunTimeTicks:
      duration === null ? undefined : Math.round(duration * ticksPerSecond),
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: planned === undefined || hls,
    SupportsDirectStream: planned === undefined || method === "remux",
    SupportsDirectPlay: planned === undefined || method === "direct-play",
    IsInfiniteStream: false,
    UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    VideoType: "VideoFile",
    MediaStreams: version.streams.map((stream) =>
      mediaStream(itemId, version.id, stream, planned ?? undefined),
    ),
    MediaAttachments: [],
    Formats: [],
    Bitrate:
      bitrates.length === 0
        ? undefined
        : bitrates.reduce((sum, bitrate) => sum + bitrate, 0),
    RequiredHttpHeaders: {},
    TranscodingUrl:
      hls && planned?.query != null
        ? `/videos/${toGuid(itemId)}/master.m3u8?${planned.query}`
        : undefined,
    TranscodingSubProtocol: hls ? "hls" : "http",
    TranscodingContainer: hls ? "mp4" : undefined,
    DefaultAudioStreamIndex: defaultAudio,
    DefaultSubtitleStreamIndex: defaultSubtitle,
    HasSegments: false,
  };
}
