import type { PendiaClient } from "./api.ts";

/** The client profile `playback.plan` decides against. */
export type ClientProfile = Parameters<
  PendiaClient["playback"]["plan"]
>[0]["profile"];

/** What a browser can decode, asked one MIME type at a time. */
export type MediaSupport = {
  /** Whether the video element opens this container progressively. */
  container: (mime: string) => boolean;
  /** Whether the player decodes this codec, as fragmented MP4 when it can. */
  codec: (mime: string) => boolean;
  /** Whether the display shows high dynamic range. */
  hdr: boolean;
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
  });
}

/** Swaps the playback token on an absolute playback URL. */
export function withToken(url: string, token: string): string {
  const next = new URL(url);
  next.searchParams.set("token", token);
  return next.href;
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
