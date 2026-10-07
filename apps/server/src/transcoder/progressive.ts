import type { PlaybackDecision } from "../playback/decisions.ts";
import { audioArguments, videoArguments } from "./live-run.ts";

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
};

// A keyframe every four seconds lets MSE seek inside the buffered range.
const forcedKeyframes = "expr:gte(t,n_forced*4)";

/**
 * Builds the ffmpeg argument list for one progressive fMP4 stream to stdout.
 * `-copyts` keeps a stream copy's timestamps absolute: the first moof's tfdt is
 * the source time of its first frame, the keyframe at or before the seek. A
 * re-encode rebases tfdt to its first frame no matter the flags (see the spike
 * in the #135 plan notes); clients add the start back with
 * SourceBuffer.timestampOffset.
 */
export function progressiveArguments(run: ProgressiveRun) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (run.startSeconds > 0) {
    args.push(
      "-seek_timestamp",
      "1",
      "-ss",
      `${Math.ceil(run.startSeconds * 1e6)}us`,
    );
  }
  args.push(
    "-i",
    run.inputPath,
    ...videoArguments(run, forcedKeyframes),
    ...audioArguments(run),
    "-sn",
    "-dn",
    "-copyts",
    "-avoid_negative_ts",
    "disabled",
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
