/** An HDR flavour a client can render or a backend can tone map. */
export type Hdr = "sdr" | "hdr10" | "hdr10+" | "hlg" | "dolby-vision";

/** A normalized client profile: accepted formats in preference order. */
export type ClientProfile = {
  containers: readonly string[];
  videoCodecs: readonly {
    codec: string;
    profiles?: readonly string[];
    maxLevel?: number;
    maxWidth?: number;
    maxHeight?: number;
  }[];
  audioCodecs: readonly { codec: string; maxChannels: number }[];
  subtitleFormats: readonly string[];
  hdr: readonly Hdr[];
  maxBitrate?: number | null;
};

/** The policy bitrate caps applying to one session, in bits per second. */
export type PlaybackCaps = {
  globalDefault?: number | null;
  userOverride?: number | null;
  sessionRequest?: number | null;
  isLan: boolean;
};

/** Returns the lowest policy cap in bits per second, or null when uncapped or on LAN. */
export function effectiveCap(caps: PlaybackCaps) {
  if (caps.isLan) return null;
  const limits = [
    caps.globalDefault,
    caps.userOverride,
    caps.sessionRequest,
  ].filter((value): value is number => value != null);
  return limits.length === 0 ? null : Math.min(...limits);
}

/** The transcode bitrate ladder, highest first, in bits per second with bounding boxes. */
export const ladder = [
  { bitrate: 20_000_000, width: 3840, height: 2160 },
  { bitrate: 10_000_000, width: 1920, height: 1080 },
  { bitrate: 6_000_000, width: 1920, height: 1080 },
  { bitrate: 3_000_000, width: 1280, height: 720 },
  { bitrate: 1_500_000, width: 854, height: 480 },
] as const;

/** Returns the first rung at or under the cap; undefined when the cap is below every rung. */
export function selectLadderRung(cap: number | null) {
  return ladder.find((rung) => cap === null || rung.bitrate <= cap);
}

/** Encoder backends in preference order. */
export const backendPreference = [
  "qsv",
  "vaapi",
  "nvenc",
  "vulkan",
  "cpu",
] as const;

/** A transcode backend name. */
export type Backend = (typeof backendPreference)[number];

/** The codecs a backend asserts it can encode and the HDR flavours it can tone map. */
export type BackendCapabilities = {
  codecs: readonly string[];
  toneMapping: readonly Exclude<Hdr, "sdr">[];
};

/** Asserted capabilities per backend; cpu is always present, hardware is absent unless supplied. */
export type CapabilityTable = { cpu: BackendCapabilities } & Partial<
  Record<Exclude<Backend, "cpu">, BackendCapabilities>
>;

/** The CPU baseline: AV1, HEVC and H264 encode plus every named HDR tone map. */
export const cpuCapabilities = {
  cpu: {
    codecs: ["av1", "hevc", "h264"],
    toneMapping: ["hdr10", "hdr10+", "hlg", "dolby-vision"],
  },
} as const satisfies CapabilityTable;

/** Returns the first backend in preference order asserting the codec and tone map, or undefined. */
export function selectBackend(
  table: CapabilityTable,
  codec: string,
  toneMap: Exclude<Hdr, "sdr"> | null = null,
  forceCpu = false,
) {
  return backendPreference.find((backend) => {
    if (forceCpu && backend !== "cpu") return false;
    const capability = table[backend];
    return (
      capability?.codecs.includes(codec) === true &&
      (toneMap === null || capability.toneMapping.includes(toneMap))
    );
  });
}
