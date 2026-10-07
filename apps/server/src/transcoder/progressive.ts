import type { PlaybackDecision } from "../playback/decisions.ts";
import { audioArguments, videoArguments } from "./live-run.ts";
import { audioMap as audioMapArgs } from "./remux.ts";

/** Everything one progressive ffmpeg run needs: the input, where to start and the outputs. */
export type ProgressiveRun = {
  inputPath: string;
  /** Source seconds to start streaming at; 0 plays from the start. */
  startSeconds: number;
  video: PlaybackDecision["video"];
  /** The audio Stream to play, counted among audio Streams; absent plays the first when the File has one. */
  audioStream?: number;
  /** That audio Stream's decision; absent copies it. */
  audio?: PlaybackDecision["audio"];
  /** The subtitle Stream, counted among subtitle Streams, burned into a re-encoded video. */
  burnSubtitle?: number;
  /**
   * Where a copied audio track starts in the source — the video anchor's
   * time, so its timeline shares the video's. Set it whenever audio copies
   * and the run starts away from zero; the muxer zeroes each track to its
   * own first packet, so a copied track must be sought on its own input to
   * stay aligned to the video.
   */
  audioStartSeconds?: number;
};

// A keyframe every four seconds lets MSE seek inside the buffered range.
const forcedKeyframes = "expr:gte(t,n_forced*4)";

/**
 * Builds the ffmpeg argument list for one progressive fMP4 stream to stdout.
 * Timestamps are always relative to the run's first frame: ffmpeg's muxer
 * rebases them when everything copies or re-encodes, and only keeps absolute
 * `-copyts` times on mixed copy/encode runs, which is too inconsistent to
 * depend on (see the spike notes in the #135 plan). The run tells the client
 * where stream-time zero lands through the `x-stream-offset` response header,
 * and it becomes MSE's SourceBuffer.timestampOffset.
 */
const seekTo = (seconds: number) => [
  "-seek_timestamp",
  "1",
  "-ss",
  `${Math.ceil(seconds * 1e6)}us`,
];

export function progressiveArguments(run: ProgressiveRun) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (run.startSeconds > 0) {
    // A demuxer seek lands on the keyframe at or before the position.
    args.push(...seekTo(run.startSeconds));
  }
  args.push("-i", run.inputPath);
  const audio = run.audio;
  const copiesAudio = audio == null || audio.action === "copy";
  if (
    copiesAudio &&
    run.audioStartSeconds !== undefined &&
    run.audioStartSeconds > 0
  ) {
    // A second input seeks the copied track to the video anchor.
    args.push(...seekTo(run.audioStartSeconds), "-i", run.inputPath);
  }
  args.push(
    ...videoArguments(run, forcedKeyframes),
    ...(copiesAudio
      ? run.audioStartSeconds !== undefined && run.audioStartSeconds > 0
        ? ["-map", `1:a:${run.audioStream ?? 0}`, "-c:a", "copy"]
        : [...audioMapArgs(run.audioStream), "-c:a", "copy"]
      : audioArguments(run)),
    "-sn",
    "-dn",
    // Frames before the seek land negative; zero the floor so they stay in.
    "-avoid_negative_ts",
    "make_zero",
    "-f",
    "mp4",
    // delay_moov lets the muxer finish parsing an AC-3 or E-AC-3 header before
    // it writes moov (live-run.ts documents why). delay_moov alone left empty
    // output when a truncated run ended before EAC3 finished parsing; with the
    // long fragment duration below, fragments still flow on long GOPs.
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof+delay_moov",
    "-frag_duration",
    "2000000",
    "pipe:1",
  );
  return args;
}
