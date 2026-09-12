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

type LevelBound = readonly [
  level: number,
  maxPicture: number,
  maxBitrate: number,
  maxSamplesPerSecond: number,
  maxWidth?: number,
  maxHeight?: number,
];
const levelBounds: Readonly<
  Record<string, { blockSize: number; bounds: readonly LevelBound[] }>
> = {
  h264: {
    blockSize: 16,
    bounds: [
      [20, 396, 2_000_000, 11880],
      [21, 792, 4_000_000, 19800],
      [22, 1620, 4_000_000, 20250],
      [30, 1620, 10_000_000, 40500],
      [31, 3600, 14_000_000, 108000],
      [32, 5120, 20_000_000, 216000],
      [40, 8192, 20_000_000, 245760],
      [41, 8192, 50_000_000, 245760],
      [42, 8704, 50_000_000, 522240],
      [50, 22080, 135_000_000, 589824],
      [51, 36864, 240_000_000, 983040],
      [52, 36864, 240_000_000, 2073600],
      [60, 139264, 240_000_000, 4177920],
      [61, 139264, 480_000_000, 8355840],
      [62, 139264, 800_000_000, 16711680],
    ],
  },
  hevc: {
    blockSize: 1,
    bounds: [
      [60, 122880, 1_500_000, 3686400],
      [63, 245760, 3_000_000, 7372800],
      [90, 552960, 6_000_000, 16588800],
      [93, 983040, 10_000_000, 33177600],
      [120, 2228224, 12_000_000, 66846720],
      [123, 2228224, 20_000_000, 133693440],
      [150, 8912896, 25_000_000, 267386880],
      [153, 8912896, 40_000_000, 534773760],
      [156, 8912896, 60_000_000, 1069547520],
      [180, 35651584, 60_000_000, 1069547520],
      [183, 35651584, 120_000_000, 2139095040],
      [186, 35651584, 240_000_000, 4278190080],
    ],
  },
  av1: {
    blockSize: 1,
    bounds: [
      [0, 147456, 1_500_000, 4423680, 2048, 1152],
      [1, 278784, 3_000_000, 8363520, 2816, 1584],
      [4, 665856, 6_000_000, 19975680, 4352, 2448],
      [5, 1065024, 10_000_000, 31950720, 5504, 3096],
      [8, 2359296, 12_000_000, 70778880, 6144, 3456],
      [9, 2359296, 20_000_000, 141557760, 6144, 3456],
      [12, 8912896, 30_000_000, 267386880, 8192, 4352],
      [13, 8912896, 40_000_000, 534773760, 8192, 4352],
      [14, 8912896, 60_000_000, 1069547520, 8192, 4352],
      [15, 8912896, 60_000_000, 1069547520, 8192, 4352],
      [16, 35651584, 60_000_000, 1069547520, 16384, 8704],
      [17, 35651584, 100_000_000, 2139095040, 16384, 8704],
      [18, 35651584, 160_000_000, 4278190080, 16384, 8704],
      [19, 35651584, 160_000_000, 4278190080, 16384, 8704],
    ],
  },
};

/** Returns the safe frame-rate ceiling for the planned output, or undefined when it cannot fit. */
export function outputFrameRateLimit(
  codec: string,
  level: number,
  width: number,
  height: number,
  bitrate: number,
) {
  const limits = levelBounds[codec];
  if (!limits) return undefined;
  const w = Math.ceil(width / limits.blockSize);
  const h = Math.ceil(height / limits.blockSize);
  const bound = limits.bounds.findLast(
    ([ceiling, maxPicture, maxBitrate, , maxWidth, maxHeight]) =>
      ceiling <= level &&
      bitrate <= maxBitrate &&
      w * h <= maxPicture &&
      (maxWidth === undefined ? w * w <= 8 * maxPicture : w <= maxWidth) &&
      (maxHeight === undefined ? h * h <= 8 * maxPicture : h <= maxHeight),
  );
  return bound === undefined ? undefined : Math.floor(bound[3] / (w * h));
}

/** Checks planned bitrate and frame size against conservative codec-level limits. */
export function outputFitsLevel(
  codec: string,
  level: number,
  width: number,
  height: number,
  bitrate: number,
) {
  return (
    outputFrameRateLimit(codec, level, width, height, bitrate) !== undefined
  );
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
