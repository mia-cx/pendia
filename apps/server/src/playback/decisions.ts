import {
  type CapabilityTable,
  type ClientProfile,
  cpuCapabilities,
  effectiveCap,
  type Hdr,
  outputFrameRateLimit,
  type PlaybackCaps,
  selectBackend,
  selectLadderRung,
} from "./policy.ts";

/** A normalized video Stream: codec, constraints, dimensions, bitrate and HDR flavour. */
export type VideoStream = {
  codec: string;
  profile?: string | null;
  level?: number | null;
  width: number;
  height: number;
  bitrate: number;
  hdr: Hdr;
  dvProfile?: number | null;
};

/** A normalized audio Stream: codec, channel count, probed bitrate and default flag. */
export type AudioStream = {
  codec: string;
  profile?: string | null;
  channels: number;
  bitrate?: number | null;
  default?: boolean;
};

/** A normalized subtitle Stream: format and text-or-bitmap kind. */
export type SubtitleStream = { format: string; kind: "text" | "bitmap" };

/**
 * The audio and subtitle Streams a session plays, counted among Streams of
 * their kind as ffmpeg counts them. No audio plays the default-flagged audio
 * Stream, else the first. No subtitle keeps every subtitle Stream; null
 * turns subtitles off.
 */
export type StreamSelection = { audio?: number; subtitle?: number | null };

/** The selected container and Streams of the Version being played. */
export type PlaybackSource = {
  container: string;
  video: VideoStream;
  audio: readonly AudioStream[];
  subtitles: readonly SubtitleStream[];
  selection?: StreamSelection;
};

/** A session's resolved selection: the audio Stream it plays, null without audio, and the subtitle choice as given. */
export type ResolvedSelection = {
  audio: number | null;
  subtitle?: number | null;
};

/** The audio Stream a File plays by default: the default-flagged one, else the first; null without audio. */
export function defaultAudio(source: PlaybackSource) {
  if (source.audio.length === 0) return null;
  return Math.max(
    source.audio.findIndex((audio) => audio.default === true),
    0,
  );
}

/** Resolves a source's selection; throws a RangeError for a Stream the source lacks. */
export function resolveSelection(source: PlaybackSource): ResolvedSelection {
  const audio = source.selection?.audio;
  if (audio !== undefined && source.audio[audio] === undefined)
    throw new RangeError(`No audio Stream ${audio}.`);
  const subtitle = source.selection?.subtitle;
  if (subtitle != null && source.subtitles[subtitle] === undefined)
    throw new RangeError(`No subtitle Stream ${subtitle}.`);
  return {
    audio: audio ?? defaultAudio(source),
    ...(subtitle === undefined ? {} : { subtitle }),
  };
}

/** The subtitle Streams a source's selection keeps, each with its position among subtitle Streams. */
function selectedSubtitles(source: PlaybackSource) {
  const choice = source.selection?.subtitle;
  return source.subtitles.flatMap((subtitle, stream) =>
    choice === undefined || choice === stream ? [{ stream, subtitle }] : [],
  );
}

function videoCap(client: ClientProfile, cap: number | null) {
  const limit = Math.min(cap ?? Infinity, client.maxBitrate ?? Infinity);
  return limit === Infinity ? null : limit;
}

function playbackHdr(video: VideoStream, supportsDolbyVision: boolean) {
  return video.hdr === "dolby-vision" &&
    !supportsDolbyVision &&
    (video.dvProfile === 7 || video.dvProfile === 8)
    ? ("hdr10" as const)
    : video.hdr;
}

/** Returns whether the video Stream plays without re-encoding under the client profile and cap. */
export function videoPasses(
  video: VideoStream,
  client: ClientProfile,
  cap: number | null,
) {
  const limit = videoCap(client, cap);
  const hdr = playbackHdr(video, client.hdr.includes("dolby-vision"));
  return (
    (hdr === "sdr" || client.hdr.includes(hdr)) &&
    (limit === null || video.bitrate <= limit) &&
    client.videoCodecs.some(
      (candidate) =>
        candidate.codec === video.codec &&
        (candidate.profiles === undefined ||
          (video.profile != null &&
            candidate.profiles.includes(video.profile))) &&
        (candidate.maxLevel === undefined ||
          (video.level != null && video.level <= candidate.maxLevel)) &&
        video.width <= (candidate.maxWidth ?? Infinity) &&
        video.height <= (candidate.maxHeight ?? Infinity),
    )
  );
}

const hdrProfiles: Readonly<Record<string, readonly string[]>> = {
  h264: ["high10", "high422", "high444"],
  hevc: ["main10", "main12"],
  av1: ["main", "high", "professional"],
  vp9: ["2", "3"],
};

function hdrOutputProfile(candidate: ClientProfile["videoCodecs"][number]) {
  const profiles = hdrProfiles[candidate.codec] ?? [];
  return candidate.profiles === undefined
    ? (profiles[0] ?? null)
    : (candidate.profiles.find((profile) => profiles.includes(profile)) ??
        null);
}

function decideVideo(
  video: VideoStream,
  client: ClientProfile,
  cap: number | null,
  capabilities: CapabilityTable,
  burnSubtitles: boolean,
  hls: boolean,
) {
  if (
    !burnSubtitles &&
    videoPasses(video, client, cap) &&
    (!hls || hlsCopyVideo.has(video.codec))
  ) {
    const hdr = playbackHdr(video, client.hdr.includes("dolby-vision"));
    return {
      action: "copy" as const,
      codec: video.codec,
      hdr,
      stripDolbyVision: video.hdr === "dolby-vision" && hdr === "hdr10",
    };
  }
  const hdr = playbackHdr(video, false);
  const forceCpu = video.hdr === "dolby-vision" && video.dvProfile === 5;
  const rung = selectLadderRung(videoCap(client, cap));
  if (!rung) throw new Error("No ladder rung fits the bitrate cap.");
  const candidates = [
    ...new Set(client.videoCodecs.map((entry) => entry.codec)),
  ].flatMap((codec) => {
    const entries = client.videoCodecs.filter((entry) => entry.codec === codec);
    if (hdr === "sdr" || hdr === "dolby-vision" || !client.hdr.includes(hdr))
      return entries;
    return entries.toSorted(
      (a, b) =>
        Number(hdrOutputProfile(b) !== null) -
        Number(hdrOutputProfile(a) !== null),
    );
  });
  for (const candidate of candidates) {
    if (candidate.profiles?.length === 0) continue;
    const hdrProfile = hdrOutputProfile(candidate);
    const preservesHdr = hdr !== "dolby-vision" && hdrProfile !== null;
    const toneMap = forceCpu
      ? ("dolby-vision" as const)
      : hdr !== "sdr" && (!client.hdr.includes(hdr) || !preservesHdr)
        ? hdr
        : null;
    const backend = selectBackend(
      capabilities,
      candidate.codec,
      toneMap,
      forceCpu,
    );
    if (!backend) continue;
    const scale = Math.min(
      1,
      rung.width / video.width,
      rung.height / video.height,
      (candidate.maxWidth ?? Infinity) / video.width,
      (candidate.maxHeight ?? Infinity) / video.height,
    );
    const width = Math.max(2, Math.floor((video.width * scale) / 2) * 2);
    const height = Math.max(2, Math.floor((video.height * scale) / 2) * 2);
    const maxFrameRate =
      candidate.maxLevel === undefined
        ? null
        : outputFrameRateLimit(
            candidate.codec,
            candidate.maxLevel,
            width,
            height,
            rung.bitrate,
          );
    if (maxFrameRate === undefined) continue;
    return {
      action: "transcode" as const,
      codec: candidate.codec,
      profile:
        hdr !== "sdr" && toneMap === null && hdrProfile !== null
          ? hdrProfile
          : (candidate.profiles?.[0] ?? null),
      level: candidate.maxLevel ?? null,
      maxFrameRate,
      width,
      height,
      bitrate: rung.bitrate,
      rung,
      hdr: toneMap === null ? hdr : ("sdr" as const),
      toneMap,
      backend,
      burnSubtitles,
    };
  }
  throw new Error("No backend supports the required video output.");
}

/** Video codecs the fMP4 muxer takes on a stream copy; anything else transcodes over HLS. */
export const hlsCopyVideo = new Set([
  "h264",
  "hevc",
  "av1",
  "vp9",
  "mpeg4",
  "mpeg2video",
]);

/** Audio codecs the fMP4 muxer takes on a stream copy; anything else transcodes over HLS. */
export const hlsCopyAudio = new Set([
  "aac",
  "ac3",
  "eac3",
  "opus",
  "flac",
  "mp3",
  "alac",
  "dts",
]);

function decideAudio(audio: AudioStream, client: ClientProfile, hls: boolean) {
  const accepts = (codec: string, channels: number) =>
    client.audioCodecs.some(
      (candidate) =>
        candidate.codec === codec && candidate.maxChannels >= channels,
    );
  if (
    accepts(audio.codec, audio.channels) &&
    (!hls || hlsCopyAudio.has(audio.codec))
  ) {
    return {
      action: "copy" as const,
      codec: audio.codec,
      channels: audio.channels,
    };
  }
  if (audio.channels >= 6 && accepts("eac3", 6)) {
    return { action: "transcode" as const, codec: "eac3", channels: 6 };
  }
  if (!accepts("aac", 2)) {
    throw new Error("The client does not support AAC stereo fallback.");
  }
  return { action: "transcode" as const, codec: "aac", channels: 2 };
}

function decideSubtitle(
  subtitle: SubtitleStream,
  client: ClientProfile,
  hls: boolean,
) {
  if (
    client.subtitleFormats.includes(subtitle.format) &&
    !(hls && subtitle.kind === "text" && subtitle.format !== "webvtt")
  ) {
    return { action: "copy" as const, format: subtitle.format };
  }
  if (subtitle.kind === "text") {
    return {
      action: "convert" as const,
      format: "webvtt",
      delivery: "sidecar" as const,
    };
  }
  return { action: "burn" as const, format: subtitle.format };
}

/** Reports whether the client needs a selected subtitle burned into the video: a bitmap Stream it cannot draw. Holds whatever the video and audio decide. */
export function requiresBurnIn(source: PlaybackSource, client: ClientProfile) {
  return selectedSubtitles(source).some(
    ({ subtitle }) => decideSubtitle(subtitle, client, false).action === "burn",
  );
}

/** Returns the play method and the decisions for the selected Streams of a source on one client. */
export function decidePlayback(
  source: PlaybackSource,
  client: ClientProfile,
  caps: PlaybackCaps,
  capabilities: CapabilityTable = cpuCapabilities,
) {
  const cap = effectiveCap(caps);
  const selection = resolveSelection(source);
  const selectedAudio =
    selection.audio === null ? undefined : source.audio[selection.audio];
  const decideSubtitles = (hls: boolean) =>
    selectedSubtitles(source).map(({ stream, subtitle }) => ({
      stream,
      ...decideSubtitle(subtitle, client, hls),
    }));
  const subtitles = decideSubtitles(false);
  const burnSubtitles = requiresBurnIn(source, client);
  const video = decideVideo(
    source.video,
    client,
    cap,
    capabilities,
    burnSubtitles,
    false,
  );
  const directAudio =
    selectedAudio === undefined
      ? null
      : decideAudio(selectedAudio, client, false);
  if (
    client.containers.includes(source.container) &&
    video.action === "copy" &&
    !video.stripDolbyVision &&
    (directAudio === null || directAudio.action === "copy") &&
    // A direct play gets the File's default audio Stream.
    selection.audio === defaultAudio(source) &&
    subtitles.every((subtitle) => subtitle.action === "copy")
  ) {
    return {
      method: "direct-play" as const,
      video,
      audio: directAudio,
      subtitles,
      selection,
    };
  }
  const audio =
    selectedAudio === undefined
      ? null
      : decideAudio(selectedAudio, client, true);
  const hlsVideo = decideVideo(
    source.video,
    client,
    cap,
    capabilities,
    burnSubtitles,
    true,
  );
  const transcodes =
    hlsVideo.action === "transcode" || audio?.action === "transcode";
  return {
    method: transcodes ? ("transcode" as const) : ("remux" as const),
    video: hlsVideo,
    audio,
    subtitles: decideSubtitles(true),
    selection,
  };
}

/** The engine's full output for one plan, persisted on the session. */
export type PlaybackDecision = ReturnType<typeof decidePlayback>;

/** What the engine decided for one subtitle Stream: copy, convert to WebVTT or burn in. */
export type SubtitleDecision = ReturnType<typeof decideSubtitle>;

/** A session's persisted plan: the decision, or "stored" with its selection when no live path exists, plus the stored rungs served instead of a live run. */
export type SessionDecision = (
  | PlaybackDecision
  | { method: "stored"; selection: ResolvedSelection }
) & {
  storedVariantIds?: string[];
};
