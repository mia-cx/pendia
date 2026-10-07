import type { ThaliaClient } from "./api.ts";

/** The client profile `playback.plan` decides against. */
export type ClientProfile = Parameters<
  ThaliaClient["playback"]["plan"]
>[0]["profile"];

/** What a browser can decode, asked one MIME type at a time. */
export type MediaSupport = {
  /** Whether the video element opens this container progressively. */
  container: (mime: string) => boolean;
  /** Whether the player decodes this codec, as fragmented MP4 when it can. */
  codec: (mime: string) => boolean;
  /** Whether the display shows high dynamic range. */
  hdr: boolean;
  /** Whether the page can feed a stream through Media Source Extensions. */
  mse: boolean;
};

const containers = [
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
  ["mkv", "video/x-matroska"],
] as const;

// One codec string per profile, named as the probe stores ffprobe's profile.
const videoCodecs = {
  h264: {
    constrainedbaseline: "avc1.42E01E",
    baseline: "avc1.42001E",
    main: "avc1.4D401F",
    high: "avc1.640028",
    high10: "avc1.6E0028",
  },
  hevc: { main: "hvc1.1.6.L120.90", main10: "hvc1.2.4.L120.90" },
  av1: { main: "av01.0.08M.08" },
  vp9: { profile0: "vp09.00.10.08", profile2: "vp09.02.10.10" },
};

// Browsers downmix what they decode, so channels follow the codec's own limit.
const audioCodecs = [
  { codec: "aac", type: "mp4a.40.2", maxChannels: 8 },
  { codec: "mp3", type: "mp4a.6B", maxChannels: 2 },
  { codec: "opus", type: "opus", maxChannels: 8 },
  { codec: "flac", type: "flac", maxChannels: 8 },
  { codec: "ac3", type: "ac-3", maxChannels: 6 },
  { codec: "eac3", type: "ec-3", maxChannels: 8 },
];

/** Builds the client profile from what the browser reports it can decode. */
export function clientProfile(support: MediaSupport): ClientProfile {
  return {
    containers: containers
      .filter(([, mime]) => support.container(mime))
      .map(([name]) => name),
    videoCodecs: Object.entries(videoCodecs).flatMap(([codec, profiles]) => {
      const decoded = Object.entries(profiles)
        .filter(([, type]) => support.codec(`video/mp4; codecs="${type}"`))
        .map(([profile]) => profile);
      return decoded.length === 0 ? [] : [{ codec, profiles: decoded }];
    }),
    audioCodecs: audioCodecs
      .filter(({ type }) => support.codec(`audio/mp4; codecs="${type}"`))
      .map(({ codec, maxChannels }) => ({ codec, maxChannels })),
    subtitleFormats: ["webvtt"],
    hdr: support.hdr ? ["sdr", "hdr10", "hlg"] : ["sdr"],
    progressive: support.mse,
  };
}

/** The profile of the browser this page runs in. */
export function browserProfile(): ClientProfile {
  const video = document.createElement("video");
  // Safari on iPhone has only ManagedMediaSource; old iPhones have neither.
  const source: typeof MediaSource | undefined =
    globalThis.ManagedMediaSource ?? globalThis.MediaSource;
  return clientProfile({
    container: (mime) => video.canPlayType(mime) !== "",
    codec: (mime) =>
      source === undefined
        ? video.canPlayType(mime) !== ""
        : source.isTypeSupported(mime),
    hdr: matchMedia("(video-dynamic-range: high)").matches,
    mse: source !== undefined,
  });
}

/**
 * Builds the MSE MIME for a progressive stream's codecs; null when the plan
 * names a codec or profile the tables don't know.
 */
export function progressiveMime(
  output: {
    video: { codec: string; profile: string | null };
    audio: { codec: string } | null;
  } | null,
): string | null {
  if (output === null) return null;
  const profiles = videoCodecs[output.video.codec as keyof typeof videoCodecs];
  if (profiles === undefined) return null;
  const video =
    (output.video.profile === null
      ? undefined
      : profiles[output.video.profile as keyof typeof profiles]) ??
    Object.values(profiles)[0];
  if (video === undefined) return null;
  const audio =
    output.audio === null
      ? null
      : (audioCodecs.find(({ codec }) => codec === output.audio?.codec)?.type ??
        null);
  if (output.audio !== null && audio === null) return null;
  return `video/mp4; codecs="${[video, audio].filter((part) => part !== null).join(",")}"`;
}

/** Swaps the playback token on a playback URL, resolved against the page. */
export function withToken(url: string, token: string, page: string): string {
  const next = new URL(url, page);
  next.searchParams.set("token", token);
  return next.href;
}

type Plan = Awaited<ReturnType<ThaliaClient["playback"]["plan"]>>;

/** One audio Stream of the planned Version. */
export type AudioStream = Plan["audioStreams"][number];

/** One subtitle Stream of the planned Version. */
export type SubtitleStream = Plan["subtitleStreams"][number];

const languages = new Intl.DisplayNames(["en"], { type: "language" });

// "und" is the probe's tag for an unknown language.
function languageName(code: string | null) {
  if (code === null || code === "und") return null;
  try {
    return languages.of(code) ?? null;
  } catch {
    return code;
  }
}

const layouts: Record<number, string> = {
  1: "Mono",
  2: "Stereo",
  6: "5.1",
  8: "7.1",
};

// Names that repeat take their place in the list, so every option differs.
function unique(names: string[]) {
  return names.map((name, position) =>
    names.indexOf(name) === names.lastIndexOf(name)
      ? name
      : `${name} (${position + 1})`,
  );
}

/** Menu names for audio Streams, such as `Japanese · 5.1`. */
export function audioNames(streams: readonly AudioStream[]): string[] {
  return unique(
    streams.map((stream, position) => {
      const name =
        stream.title ??
        languageName(stream.language) ??
        `Audio ${position + 1}`;
      const layout =
        stream.channels === null ? undefined : layouts[stream.channels];
      return layout === undefined ? name : `${name} · ${layout}`;
    }),
  );
}

/** Menu names for subtitle Streams, such as `English · Forced`. */
export function subtitleNames(streams: readonly SubtitleStream[]): string[] {
  return unique(
    streams.map((stream, position) => {
      const name =
        stream.title ??
        languageName(stream.language) ??
        `Subtitles ${position + 1}`;
      return stream.forced ? `${name} · Forced` : name;
    }),
  );
}

/**
 * The Version to open: the one a link asked for, else the one progress was
 * made on, else the first.
 */
export function pickVersion<V extends { id: string }>(
  versions: readonly V[],
  askedId: string | null,
  progressId: string | null | undefined,
): V | undefined {
  return (
    versions.find((version) => version.id === askedId) ??
    versions.find((version) => version.id === progressId) ??
    versions[0]
  );
}

/** A playback position as `12:34` or `1:02:03`. */
export function formatPosition(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours === 0
    ? `${minutes}:${rest}`
    : `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
}
