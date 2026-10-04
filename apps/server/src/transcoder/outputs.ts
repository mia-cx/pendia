import type {
  PlaybackDecision,
  PlaybackSource,
} from "../playback/decisions.ts";
import {
  type PlaylistVariant,
  type SubtitleRendition,
  variantCodecs,
} from "../playback/playlists.ts";
import {
  type AudioDecision,
  audioBitrates,
  type VideoDecision,
} from "./live-run.ts";

/** Probe details of one subtitle Stream that name its rendition. */
export type SubtitleDetails = {
  language: string | null;
  title: string | null;
  disposition: Record<string, boolean>;
};

/** What a session's runs write and what its master playlist advertises. */
export type SessionOutputs = {
  video: VideoDecision;
  audio: AudioDecision | undefined;
  burnSubtitle: number | undefined;
  variant: PlaylistVariant;
  subtitles: SubtitleRendition[];
};

const audioOutput = (audio: AudioDecision) =>
  audio.codec === "aac"
    ? { codec: "aac", profile: "lc", bitrate: audioBitrates.aac }
    : { codec: audio.codec, profile: null, bitrate: audioBitrates.eac3 };

/**
 * Derives a session's outputs from the decision persisted at plan time. A
 * session without one copies the video and the first audio Stream.
 * Subtitle Streams are counted in File order, details aligned with the source.
 */
export function sessionOutputs(
  decision: PlaybackDecision | null | undefined,
  source: PlaybackSource,
  details: readonly SubtitleDetails[],
): SessionOutputs {
  const video: VideoDecision = decision?.video ?? {
    action: "copy",
    codec: source.video.codec,
    hdr: source.video.hdr,
    stripDolbyVision: false,
  };
  const audio = decision?.audio[0];
  const subtitleDecisions =
    decision?.subtitles ??
    source.subtitles.map((subtitle) => ({
      action:
        subtitle.kind === "text" ? ("convert" as const) : ("burn" as const),
      format: subtitle.format,
    }));
  const burned = subtitleDecisions.findIndex(
    (subtitle) => subtitle.action === "burn",
  );
  const burnSubtitle =
    video.action === "transcode" && video.burnSubtitles && burned >= 0
      ? burned
      : undefined;

  const sourceAudio = source.audio[0];
  const outputAudio =
    audio?.action === "transcode"
      ? audioOutput(audio)
      : sourceAudio === undefined
        ? undefined
        : {
            codec: sourceAudio.codec,
            profile: sourceAudio.profile ?? null,
            bitrate: sourceAudio.bitrate ?? 0,
          };
  const picture =
    video.action === "transcode"
      ? {
          bitrate: video.bitrate,
          width: video.width,
          height: video.height,
          stream: {
            codec: video.codec,
            profile: video.profile,
            level: video.level,
          },
        }
      : {
          bitrate: source.video.bitrate,
          width: source.video.width,
          height: source.video.height,
          stream: {
            codec: source.video.codec,
            profile: source.video.profile ?? null,
            level: source.video.level ?? null,
          },
        };
  const variant: PlaylistVariant = {
    bandwidth: Math.round(picture.bitrate + (outputAudio?.bitrate ?? 0)),
    width: picture.width,
    height: picture.height,
    codecs: variantCodecs(picture.stream, outputAudio),
  };

  // Over HLS only WebVTT reaches the client: text converts, WebVTT copies.
  const offered = subtitleDecisions.flatMap((subtitle, index) =>
    subtitle.action === "convert" ||
    (subtitle.action === "copy" && subtitle.format === "webvtt")
      ? [index]
      : [],
  );
  const names = offered.map((index) => {
    const stream = details[index];
    return stream?.title ?? stream?.language ?? `Subtitles ${index + 1}`;
  });
  const subtitles = offered.map((index, position) => {
    const stream = details[index];
    const name = names[position] ?? "";
    // NAME is unique within a group; repeats take their Stream number.
    const unique =
      names.indexOf(name) === names.lastIndexOf(name)
        ? name
        : `${name} (${index + 1})`;
    return {
      index,
      name: unique,
      language: stream?.language ?? null,
      default: stream?.disposition.default === true,
      forced: stream?.disposition.forced === true,
    };
  });
  return { video, audio, burnSubtitle, variant, subtitles };
}
