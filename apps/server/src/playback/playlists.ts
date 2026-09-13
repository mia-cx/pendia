/** The single variant a remux master playlist advertises. */
export type PlaylistVariant = {
  bandwidth: number; // bits per second, integer
  width: number;
  height: number;
  codecs: readonly string[]; // RFC 6381 strings; empty array omits CODECS
};

const h264Profiles: Record<string, { idc: string; constraints: string }> = {
  baseline: { idc: "42", constraints: "00" },
  constrainedbaseline: { idc: "42", constraints: "E0" },
  main: { idc: "4D", constraints: "00" },
  high: { idc: "64", constraints: "00" },
  high10: { idc: "6E", constraints: "00" },
  high422: { idc: "7A", constraints: "00" },
  high444: { idc: "F4", constraints: "00" },
};

const hevcProfiles: Record<string, string> = {
  main: "hvc1.1.6",
  main10: "hvc1.2.4",
};

const audioCodecs: Record<string, string> = {
  aac: "mp4a.40.2",
  ac3: "ac-3",
  eac3: "ec-3",
  opus: "opus",
  flac: "flac",
};

/** Returns the RFC 6381 codec string for a probed Stream, or null when unknown. */
export function codecString(stream: {
  codec: string;
  profile: string | null;
  level: number | null;
}) {
  if (stream.codec === "h264") {
    const profile =
      stream.profile === null ? undefined : h264Profiles[stream.profile];
    if (profile === undefined || stream.level === null) {
      return null;
    }
    const level = stream.level.toString(16).padStart(2, "0").toUpperCase();
    return `avc1.${profile.idc}${profile.constraints}${level}`;
  }
  if (stream.codec === "hevc") {
    const prefix =
      stream.profile === null ? undefined : hevcProfiles[stream.profile];
    if (prefix === undefined || stream.level === null) {
      return null;
    }
    return `${prefix}.L${stream.level}.B0`;
  }
  return audioCodecs[stream.codec] ?? null;
}

/** Builds the master playlist: one variant whose media playlist URI carries the query. */
export function buildMasterPlaylist(variant: PlaylistVariant, query: string) {
  const attributes = [
    `BANDWIDTH=${variant.bandwidth}`,
    `RESOLUTION=${variant.width}x${variant.height}`,
  ];
  if (variant.codecs.length > 0) {
    attributes.push(`CODECS="${variant.codecs.join(",")}"`);
  }
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-STREAM-INF:${attributes.join(",")}`,
    `media.m3u8${query}`,
    "",
  ].join("\n");
}

/** Returns the number of segments a timeline describes. */
export function segmentCount(boundariesSeconds: readonly number[]) {
  return boundariesSeconds.length - 1;
}

/** Builds the complete VOD media playlist from the timeline; every URI carries the query. */
export function buildMediaPlaylist(
  boundariesSeconds: readonly number[],
  query: string,
) {
  if (boundariesSeconds.length < 2) {
    throw new Error("A timeline needs at least two boundaries.");
  }
  const durationsSeconds = boundariesSeconds
    .slice(1)
    .map((end, index) => end - (boundariesSeconds[index] ?? end));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durationsSeconds))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="init.mp4${query}"`,
  ];
  durationsSeconds.forEach((duration, index) => {
    lines.push(`#EXTINF:${duration.toFixed(6)},`, `${index}.m4s${query}`);
  });
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}
