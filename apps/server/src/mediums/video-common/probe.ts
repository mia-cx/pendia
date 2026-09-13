import { extname } from "node:path";
import { Schema } from "effect";
import type { Chapter, streams } from "../../db/schema/core.ts";

/** A normalized stream row minus database ids, with a JSON-safe decimal bitrate. */
export type ProbeStream = Omit<
  typeof streams.$inferSelect,
  "id" | "versionId" | "fileId" | "bitrate"
> & { bitrate: string | null };

/** Normalized ffprobe output: container, duration, chapters and streams. */
export interface ProbeResult {
  container: string | null;
  durationSeconds: number | null;
  chapters: Chapter[];
  streams: ProbeStream[];
}

const Numberish = Schema.Union(Schema.Number, Schema.String);

const RawTags = Schema.Struct({
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});

const RawSideData = Schema.Struct({
  side_data_type: Schema.optional(Schema.String),
  dv_profile: Schema.optional(Numberish),
});

const RawStream = Schema.Struct({
  index: Schema.optional(Numberish),
  codec_type: Schema.optional(Schema.String),
  codec_name: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  level: Schema.optional(Numberish),
  tags: Schema.optional(RawTags),
  bit_rate: Schema.optional(Numberish),
  disposition: Schema.optional(
    Schema.Record({ key: Schema.String, value: Numberish }),
  ),
  width: Schema.optional(Numberish),
  height: Schema.optional(Numberish),
  avg_frame_rate: Schema.optional(Schema.String),
  r_frame_rate: Schema.optional(Schema.String),
  duration: Schema.optional(Numberish),
  color_transfer: Schema.optional(Schema.String),
  channels: Schema.optional(Numberish),
  channel_layout: Schema.optional(Schema.String),
  sample_rate: Schema.optional(Numberish),
  side_data_list: Schema.optional(Schema.Array(RawSideData)),
});

const RawFormat = Schema.Struct({
  format_name: Schema.optional(Schema.String),
  duration: Schema.optional(Numberish),
});

const RawChapter = Schema.Struct({
  start_time: Schema.optional(Numberish),
  end_time: Schema.optional(Numberish),
  tags: Schema.optional(RawTags),
});

const RawProbe = Schema.Struct({
  streams: Schema.Array(RawStream),
  format: Schema.optional(RawFormat),
  chapters: Schema.optional(Schema.Array(RawChapter)),
});

type RawProbe = typeof RawProbe.Type;
type RawStreamDecoded = RawProbe["streams"][number];
type RawChapterDecoded = NonNullable<RawProbe["chapters"]>[number];

const toNumber = (value: number | string | undefined): number | null => {
  if (value === undefined || value === "N/A") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toInt = (
  value: number | string | undefined,
  minimum: number,
): number | null => {
  const parsed = toNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= minimum
    ? parsed
    : null;
};

const toPositiveInt = (value: number | string | undefined): number | null =>
  toInt(value, 1);

const toNonNegativeInt = (value: number | string | undefined): number | null =>
  toInt(value, 0);

const decimalInteger = (value: number | string | undefined): string | null => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  return value !== undefined && /^\d+$/.test(value)
    ? BigInt(value).toString()
    : null;
};

const parseRate = (
  value: string | undefined,
): { numerator: number; denominator: number } | null => {
  const [numerator, denominator] = (value ?? "").split("/").map(Number);
  return numerator !== undefined &&
    denominator !== undefined &&
    Number.isInteger(numerator) &&
    Number.isInteger(denominator) &&
    numerator > 0 &&
    denominator > 0
    ? { numerator, denominator }
    : null;
};

const hdrOf = (
  raw: Pick<RawStreamDecoded, "color_transfer" | "side_data_list">,
): { hdr: string; dvProfile: number | null } => {
  const sideData = raw.side_data_list ?? [];
  const dovi = sideData.find(
    (data) => data.side_data_type === "DOVI configuration record",
  );
  if (dovi) {
    return {
      hdr: "dolby-vision",
      dvProfile: toNonNegativeInt(dovi.dv_profile),
    };
  }
  if (
    sideData.some((data) => data.side_data_type?.includes("SMPTE2094") ?? false)
  ) {
    return { hdr: "hdr10+", dvProfile: null };
  }
  if (raw.color_transfer === "smpte2084") {
    return { hdr: "hdr10", dvProfile: null };
  }
  if (raw.color_transfer === "arib-std-b67") {
    return { hdr: "hlg", dvProfile: null };
  }
  return { hdr: "sdr", dvProfile: null };
};

const mapStream = (raw: RawStreamDecoded): ProbeStream | null => {
  const kind = raw.codec_type;
  if (kind !== "video" && kind !== "audio" && kind !== "subtitle") {
    return null;
  }
  const index = toNonNegativeInt(raw.index);
  if (index === null || !Number.isSafeInteger(index)) {
    throw new Error("Invalid stream index.");
  }
  const rate =
    parseRate(raw.avg_frame_rate) ?? parseRate(raw.r_frame_rate) ?? null;
  const { hdr, dvProfile } =
    kind === "video" ? hdrOf(raw) : { hdr: null, dvProfile: null };
  return {
    index,
    kind,
    codec: raw.codec_name ?? "unknown",
    profile: raw.profile
      ? raw.profile.toLowerCase().replace(/[^a-z0-9]+/g, "")
      : null,
    level: toNonNegativeInt(raw.level),
    language: raw.tags?.language ?? null,
    title: raw.tags?.title ?? null,
    bitrate: decimalInteger(raw.bit_rate),
    disposition: Object.fromEntries(
      Object.entries(raw.disposition ?? {}).map(([key, value]) => [
        key,
        (toNumber(value) ?? 0) !== 0,
      ]),
    ),
    width: toPositiveInt(raw.width),
    height: toPositiveInt(raw.height),
    frameRateNumerator: rate?.numerator ?? null,
    frameRateDenominator: rate?.denominator ?? null,
    hdr,
    dvProfile,
    channels: toPositiveInt(raw.channels),
    channelLayout: raw.channel_layout ?? null,
    sampleRate: toPositiveInt(raw.sample_rate),
  };
};

const mapChapter = (raw: RawChapterDecoded): Chapter => {
  const start = toNumber(raw.start_time);
  const end = toNumber(raw.end_time);
  if (start === null || end === null || start < 0 || end < start) {
    throw new Error(
      `Invalid chapter timing: start_time=${raw.start_time}, end_time=${raw.end_time}`,
    );
  }
  return {
    title: raw.tags?.title ?? null,
    startSeconds: start,
    endSeconds: end,
  };
};

const containerOf = (
  formatName: string | undefined,
  preferWebm: boolean,
): string | null => {
  const names = (formatName ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.includes("matroska")) {
    return preferWebm && names.includes("webm") ? "webm" : "mkv";
  }
  if (names.includes("mp4")) {
    return "mp4";
  }
  if (names.includes("webm")) {
    return "webm";
  }
  if (names.includes("mpegts")) {
    return "mpegts";
  }
  return names[0] ?? null;
};

const durationOf = (
  raw: Pick<RawProbe, "streams" | "format">,
): number | null => {
  const formatDuration = toNumber(raw.format?.duration);
  if (formatDuration !== null && formatDuration >= 0) {
    return formatDuration;
  }
  let longest: number | null = null;
  for (const stream of raw.streams) {
    const duration = toNumber(stream.duration);
    if (duration !== null && duration >= 0 && duration > (longest ?? -1)) {
      longest = duration;
    }
  }
  return longest;
};

const fromRaw = (raw: RawProbe, preferWebm: boolean): ProbeResult => {
  const streams = raw.streams
    .map(mapStream)
    .filter((stream) => stream !== null);
  const seen = new Set<number>();
  for (const stream of streams) {
    if (seen.has(stream.index)) {
      throw new Error("Duplicate stream index.");
    }
    seen.add(stream.index);
  }
  return {
    container: containerOf(raw.format?.format_name, preferWebm),
    durationSeconds: durationOf(raw),
    chapters: (raw.chapters ?? []).map(mapChapter),
    streams,
  };
};

/** Decode raw ffprobe JSON into a normalized {@link ProbeResult}. */
export function parseProbeOutput(input: unknown): ProbeResult {
  return fromRaw(Schema.decodeUnknownSync(RawProbe)(input), false);
}

/** Probe a media file with ffprobe and return normalized JSON-safe output. */
export async function probeVideo(path: string): Promise<ProbeResult> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-show_chapters",
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
  return fromRaw(
    Schema.decodeUnknownSync(RawProbe)(JSON.parse(output)),
    extname(path).toLowerCase() === ".webm",
  );
}
