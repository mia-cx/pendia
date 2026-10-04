/** One file name inside a session's HLS URL space. */
export type HlsName =
  | { kind: "master" }
  | { kind: "media" }
  | { kind: "init" }
  | { kind: "segment"; index: number }
  | { kind: "subtitles"; index: number } // subs-<n>.m3u8, the rendition's playlist
  | { kind: "subtitle"; index: number }; // subs-<n>.vtt, the whole track as WebVTT

// Canonical numbers only: no leading zeros beyond "0" itself.
const canonical = (digits: string) => digits === "0" || !digits.startsWith("0");

/** Parses the last path segment of an HLS URL; null when it names nothing we serve. */
export function parseHlsName(name: string): HlsName | null {
  if (name === "master.m3u8") return { kind: "master" };
  if (name === "media.m3u8") return { kind: "media" };
  if (name === "init.mp4") return { kind: "init" };
  const subtitle = /^subs-(\d+)\.(m3u8|vtt)$/.exec(name);
  if (subtitle?.[1] !== undefined) {
    if (!canonical(subtitle[1])) return null;
    const index = Number(subtitle[1]);
    return subtitle[2] === "m3u8"
      ? { kind: "subtitles", index }
      : { kind: "subtitle", index };
  }
  const segment = /^(\d+)\.m4s$/.exec(name)?.[1];
  if (segment === undefined || !canonical(segment)) return null;
  return { kind: "segment", index: Number(segment) };
}

/** One text subtitle Stream offered as a WebVTT rendition; index counts subtitle Streams in the File. */
export type SubtitleRendition = {
  index: number;
  name: string;
  language: string | null;
  default: boolean;
  forced: boolean;
};

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

// ISO BMFF sample entry names are case sensitive: Opus and fLaC.
const audioCodecs: Record<string, string> = {
  ac3: "ac-3",
  eac3: "ec-3",
  opus: "Opus",
  flac: "fLaC",
};

const aacProfiles: Record<string, string> = {
  lc: "mp4a.40.2",
  heaac: "mp4a.40.5",
  heaacv2: "mp4a.40.29",
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
  if (stream.codec === "aac") {
    return stream.profile === null
      ? "mp4a.40.2"
      : (aacProfiles[stream.profile] ?? null);
  }
  return audioCodecs[stream.codec] ?? null;
}

/** Returns the CODECS list for a variant; empty when any chosen codec is unknown, which omits the attribute. */
export function variantCodecs(
  video: { codec: string; profile: string | null; level: number | null },
  audio: { codec: string; profile: string | null } | undefined,
) {
  const videoCodec = codecString(video);
  if (videoCodec === null) return [];
  if (audio === undefined) return [videoCodec];
  const audioCodec = codecString({
    codec: audio.codec,
    profile: audio.profile,
    level: null,
  });
  if (audioCodec === null) return [];
  return [videoCodec, audioCodec];
}

// A quoted-string attribute cannot hold a double quote or a line break.
const quoted = (value: string) =>
  `"${value
    .replace(/["\r\n]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()}"`;

/** Builds the master playlist: one variant, plus a WebVTT rendition per text subtitle; every URI carries the query. */
export function buildMasterPlaylist(
  variant: PlaylistVariant,
  query: string,
  subtitles: readonly SubtitleRendition[] = [],
) {
  const attributes = [
    `BANDWIDTH=${variant.bandwidth}`,
    `RESOLUTION=${variant.width}x${variant.height}`,
  ];
  if (variant.codecs.length > 0) {
    attributes.push(`CODECS="${variant.codecs.join(",")}"`);
  }
  if (subtitles.length > 0) {
    attributes.push('SUBTITLES="subs"');
  }
  const renditions = subtitles.map((subtitle) =>
    [
      "#EXT-X-MEDIA:TYPE=SUBTITLES",
      'GROUP-ID="subs"',
      `NAME=${quoted(subtitle.name)}`,
      ...(subtitle.language === null
        ? []
        : [`LANGUAGE=${quoted(subtitle.language)}`]),
      `DEFAULT=${subtitle.default ? "YES" : "NO"}`,
      "AUTOSELECT=YES",
      `FORCED=${subtitle.forced ? "YES" : "NO"}`,
      `URI="subs-${subtitle.index}.m3u8${query}"`,
    ].join(","),
  );
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...renditions,
    `#EXT-X-STREAM-INF:${attributes.join(",")}`,
    `media.m3u8${query}`,
    "",
  ].join("\n");
}

/** Builds a subtitle rendition's VOD playlist: the whole track as one WebVTT segment. */
export function buildSubtitlePlaylist(
  index: number,
  durationSeconds: number,
  query: string,
) {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(durationSeconds)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${durationSeconds.toFixed(6)},`,
    `subs-${index}.vtt${query}`,
    "#EXT-X-ENDLIST",
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
