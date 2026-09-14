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

/** A normalized audio Stream: codec, channel count and probed bitrate. */
export type AudioStream = {
  codec: string;
  channels: number;
  bitrate?: number | null;
};

/** A normalized subtitle Stream: format and text-or-bitmap kind. */
export type SubtitleStream = { format: string; kind: "text" | "bitmap" };

/** The selected container and Streams of the Version being played. */
export type PlaybackSource = {
  container: string;
  video: VideoStream;
  audio: readonly AudioStream[];
  subtitles: readonly SubtitleStream[];
};

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
) {
  if (!burnSubtitles && videoPasses(video, client, cap)) {
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

function decideAudio(audio: AudioStream, client: ClientProfile, hls: boolean) {
  const accepts = (codec: string, channels: number) =>
    client.audioCodecs.some(
      (candidate) =>
        candidate.codec === codec && candidate.maxChannels >= channels,
    );
  if (
    accepts(audio.codec, audio.channels) &&
    !(hls && ["truehd", "dts-hd"].includes(audio.codec))
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

/** Returns the play method and per-Stream decisions for a source on one client. */
export function decidePlayback(
  source: PlaybackSource,
  client: ClientProfile,
  caps: PlaybackCaps,
  capabilities: CapabilityTable = cpuCapabilities,
) {
  const cap = effectiveCap(caps);
  const subtitles = source.subtitles.map((subtitle) =>
    decideSubtitle(subtitle, client, false),
  );
  const video = decideVideo(
    source.video,
    client,
    cap,
    capabilities,
    subtitles.some((subtitle) => subtitle.action === "burn"),
  );
  const directAudio = source.audio.map((audio) =>
    decideAudio(audio, client, false),
  );
  if (
    client.containers.includes(source.container) &&
    video.action === "copy" &&
    !video.stripDolbyVision &&
    directAudio.every((audio) => audio.action === "copy") &&
    subtitles.every((subtitle) => subtitle.action === "copy")
  ) {
    return {
      method: "direct-play" as const,
      video,
      audio: directAudio,
      subtitles,
    };
  }
  const audio = source.audio.map((stream) => decideAudio(stream, client, true));
  const transcodes =
    video.action === "transcode" ||
    audio.some((stream) => stream.action === "transcode");
  return {
    method: transcodes ? ("transcode" as const) : ("remux" as const),
    video,
    audio,
    subtitles: source.subtitles.map((subtitle) =>
      decideSubtitle(subtitle, client, true),
    ),
  };
}

/** The engine's full output for one plan, persisted on the session. */
export type PlaybackDecision = ReturnType<typeof decidePlayback>;
