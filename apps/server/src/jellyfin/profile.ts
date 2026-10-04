import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { isHdr } from "../playback/planning.ts";
import type { ClientProfile, Hdr } from "../playback/policy.ts";

type Names = Readonly<Record<string, readonly string[]>>;

/**
 * The one table from Jellyfin's names, lowercased, to the engine's. A name
 * missing here counts as unsupported. DTS covers DTS-HD too: every DTS-HD
 * Stream carries a core a DTS decoder plays.
 */
export const jellyfinNames: Readonly<
  Record<"container" | "video" | "audio" | "subtitle" | "range", Names>
> = {
  container: {
    mkv: ["mkv"],
    matroska: ["mkv"],
    webm: ["webm"],
    mp4: ["mp4"],
    m4v: ["mp4"],
    mov: ["mov"],
    ts: ["mpegts"],
    mpegts: ["mpegts"],
    m2ts: ["mpegts"],
  },
  video: {
    h264: ["h264"],
    avc: ["h264"],
    hevc: ["hevc"],
    h265: ["hevc"],
    av1: ["av1"],
    vp9: ["vp9"],
    vp8: ["vp8"],
    mpeg4: ["mpeg4"],
    mpeg2video: ["mpeg2video"],
    vc1: ["vc1"],
  },
  audio: {
    aac: ["aac"],
    ac3: ["ac3"],
    eac3: ["eac3"],
    truehd: ["truehd"],
    dts: ["dts", "dts-hd"],
    dca: ["dts", "dts-hd"],
    flac: ["flac"],
    opus: ["opus"],
    mp3: ["mp3"],
    alac: ["alac"],
    vorbis: ["vorbis"],
  },
  subtitle: {
    srt: ["srt"],
    subrip: ["srt"],
    ass: ["ass"],
    ssa: ["ssa"],
    vtt: ["webvtt"],
    webvtt: ["webvtt"],
    pgs: ["pgs"],
    pgssub: ["pgs"],
    dvdsub: ["vobsub"],
    vobsub: ["vobsub"],
    mov_text: ["mov_text"],
  },
  range: {
    sdr: ["sdr"],
    hdr10: ["hdr10"],
    hdr10plus: ["hdr10+"],
    hlg: ["hlg"],
    dovi: ["dolby-vision"],
  },
};

// A Stream never carries more than 7.1, so no cap means eight channels.
const uncappedChannels = 8;
const allFlavours: readonly Hdr[] = [
  "sdr",
  "hdr10",
  "hdr10+",
  "hlg",
  "dolby-vision",
];

const maybe = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.optional(Schema.NullOr(schema));
const Text = maybe(Schema.String);
const list = <A, I>(schema: Schema.Schema<A, I>) => maybe(Schema.Array(schema));

const Condition = Schema.Struct({
  condition: Text,
  property: Text,
  value: Text,
});
const CodecProfile = Schema.Struct({
  type: Text,
  codec: Text,
  conditions: list(Condition),
  applyconditions: list(Condition),
});
const MediaProfile = Schema.Struct({
  type: Text,
  container: Text,
  videocodec: Text,
  audiocodec: Text,
  protocol: Text,
});

// Keys arrive lowercased, since ASP.NET binds JSON names case-insensitively.
const DeviceProfile = Schema.Struct({
  maxstreamingbitrate: maybe(Schema.Number),
  directplayprofiles: list(MediaProfile),
  transcodingprofiles: list(MediaProfile),
  codecprofiles: list(CodecProfile),
  subtitleprofiles: list(Schema.Struct({ format: Text, method: Text })),
});

/** Copies a JSON value with every object key lowercased. */
export function lowerKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.toLowerCase(),
      lowerKeys(entry),
    ]),
  );
}

const lowered = (text: string | null | undefined) => text?.toLowerCase();

/** Maps a comma or pipe separated list of Jellyfin names to engine names, dropping unknown ones. */
function translate(kind: keyof typeof jellyfinNames, text?: string | null) {
  const names = (text ?? "")
    .split(/[,|]/)
    .map((name) => name.trim().toLowerCase().replaceAll(" ", ""));
  return [...new Set(names.flatMap((name) => jellyfinNames[kind][name] ?? []))];
}

// Probed profiles are lowercase alphanumerics: "Constrained Baseline" is "constrainedbaseline".
const profileName = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const positive = (value: string | null | undefined) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

/**
 * Translates a Jellyfin DeviceProfile into the engine's client profile.
 * DirectPlayProfiles give the containers and codecs a client opens as files,
 * an empty field meaning any, as in Jellyfin. HLS TranscodingProfiles add the codecs it decodes over HLS, first in
 * preference. Unconditional CodecProfiles narrow video profiles, level, size,
 * audio channels and HDR flavours; a profile without any VideoRangeType
 * condition takes every flavour, as Jellyfin does. Embedded SubtitleProfiles
 * give the formats it draws. `maxStreamingBitrate` from the request wins over
 * the profile's own.
 */
export function readDeviceProfile(
  value: unknown,
  maxStreamingBitrate?: number,
): ClientProfile {
  const decoded = Schema.decodeUnknownOption(DeviceProfile)(lowerKeys(value));
  if (decoded._tag === "None") throw new AuthError("INVALID_INPUT");
  const profile = decoded.value;
  const isVideo = (entry: { type?: string | null }) =>
    (lowered(entry.type) ?? "video") === "video";
  const direct = (profile.directplayprofiles ?? []).filter(isVideo);
  const hls = (profile.transcodingprofiles ?? []).filter(
    (entry) => isVideo(entry) && lowered(entry.protocol) === "hls",
  );
  // Jellyfin reads an empty DirectPlayProfile field as any value, and
  // Swiftfin's direct play mode sends only the type.
  const directNames = (
    kind: "container" | "video" | "audio",
    field: "container" | "videocodec" | "audiocodec",
  ) =>
    direct.flatMap((entry) =>
      entry[field]?.trim()
        ? translate(kind, entry[field])
        : Object.values(jellyfinNames[kind]).flat(),
    );
  const decodes = (
    kind: "video" | "audio",
    field: "videocodec" | "audiocodec",
  ) => [
    ...new Set([
      ...hls.flatMap((entry) => translate(kind, entry[field])),
      ...directNames(kind, field),
    ]),
  ];
  const codecProfiles = (profile.codecprofiles ?? []).filter(
    (entry) => (entry.applyconditions ?? []).length === 0,
  );
  const conditions = (types: string[], codec: string) =>
    codecProfiles
      .filter(
        (entry) =>
          types.includes(lowered(entry.type) ?? "") &&
          (entry.codec == null ||
            translate("video", entry.codec).includes(codec) ||
            translate("audio", entry.codec).includes(codec)),
      )
      .flatMap((entry) => entry.conditions ?? []);
  const limit = (
    found: readonly (typeof Condition.Type)[],
    property: string,
  ) => {
    const values = found
      .filter(
        (condition) =>
          lowered(condition.property) === property &&
          lowered(condition.condition) === "lessthanequal",
      )
      .flatMap((condition) => positive(condition.value) ?? []);
    return values.length === 0 ? undefined : Math.min(...values);
  };
  const equalsAny = (
    found: readonly (typeof Condition.Type)[],
    property: string,
  ) =>
    found
      .filter(
        (condition) =>
          lowered(condition.property) === property &&
          ["equals", "equalsany"].includes(lowered(condition.condition) ?? ""),
      )
      .map((condition) => condition.value ?? "");

  const videoNames = decodes("video", "videocodec");
  const videoCodecs = videoNames.map((codec) => {
    const found = conditions(["video"], codec);
    const profiles = equalsAny(found, "videoprofile");
    return {
      codec,
      ...(profiles.length === 0
        ? {}
        : {
            profiles: profiles.flatMap((value) =>
              value.split("|").map(profileName),
            ),
          }),
      maxLevel: limit(found, "videolevel"),
      maxWidth: limit(found, "width"),
      maxHeight: limit(found, "height"),
    };
  });
  const audioNames = decodes("audio", "audiocodec");
  const ranges = videoNames.flatMap((codec) =>
    equalsAny(conditions(["video"], codec), "videorangetype"),
  );
  const bitrate = maxStreamingBitrate ?? profile.maxstreamingbitrate;
  return {
    containers: [...new Set(directNames("container", "container"))],
    videoCodecs,
    audioCodecs: audioNames.map((codec) => ({
      codec,
      maxChannels:
        limit(conditions(["videoaudio", "audio"], codec), "audiochannels") ??
        uncappedChannels,
    })),
    subtitleFormats: [
      ...new Set(
        (profile.subtitleprofiles ?? [])
          .filter((entry) => lowered(entry.method) === "embed")
          .flatMap((entry) => translate("subtitle", entry.format)),
      ),
    ],
    hdr:
      ranges.length === 0
        ? allFlavours
        : [
            ...new Set([
              "sdr" as const,
              ...ranges.flatMap((range) =>
                translate("range", range).filter(isHdr),
              ),
            ]),
          ],
    maxBitrate:
      bitrate == null || !Number.isFinite(bitrate) || bitrate <= 0
        ? null
        : Math.floor(bitrate),
  };
}
