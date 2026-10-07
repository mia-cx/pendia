import { watch } from "node:fs";
import type { PlaybackDecision } from "../playback/decisions.ts";
import { audioMap } from "./remux.ts";

/** What the engine decided for the video Stream: copy, or re-encode to a rung. */
export type VideoDecision = PlaybackDecision["video"];

/** What the engine decided for one audio Stream: copy, AAC stereo or EAC3 5.1. */
export type AudioDecision = NonNullable<PlaybackDecision["audio"]>;

/** Everything one live ffmpeg run needs: the input, the timeline, the outputs, where to start and where to write. */
export type LiveRun = {
  inputPath: string;
  boundariesSeconds: readonly number[]; // the Item's timeline, first element 0, last the duration
  startIndex: number; // segment index to start at
  directory: string; // the run directory, created by the caller
  video: VideoDecision;
  /** The audio Stream to play, counted among audio Streams; absent plays the first when the File has one. */
  audioStream?: number;
  /** That audio Stream's decision; absent copies it. */
  audio?: AudioDecision;
  /** The subtitle Stream, counted among subtitle Streams, burned into a re-encoded video. */
  burnSubtitle?: number;
  readRate?: { rate: number; initialBurstSeconds: number }; // optional throttle, tests only
};

/** Audio bitrates of the two re-encode paths, in bits per second. */
export const audioBitrates = { aac: 192_000, eac3: 640_000 } as const;

/**
 * The live profile's CPU encoder per output codec. It trades quality for start
 * time. No B-frames: with them the fMP4 muxer starts each run's video two
 * frames after its boundary. No keyframes but the forced ones: the muxer may
 * cut on any keyframe near a boundary.
 */
export const liveEncoders: Record<string, readonly string[]> = {
  h264: [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-bf",
    "0",
    "-x264-params",
    "scenecut=0:keyint=infinite",
  ],
  hevc: [
    "-c:v",
    "libx265",
    "-preset",
    "superfast",
    "-x265-params",
    "bframes=0:scenecut=0:keyint=-1:log-level=error",
    "-forced-idr",
    "1",
    "-tag:v",
    "hvc1",
  ],
  av1: [
    "-c:v",
    "libsvtav1",
    "-preset",
    "10",
    // SVT-AV1 takes no infinite interval outside CRF mode; the largest it takes.
    "-svtav1-params",
    "keyint=2147483647:scd=0",
  ],
};

/** The live profile's rate control for a codec at a target bitrate in bits per second. */
export function rateArguments(codec: string, bitrate: number) {
  // SVT-AV1 takes a bitrate ceiling only in CRF mode; with -b:v it runs VBR.
  if (codec === "av1") return ["-b:v", String(bitrate)];
  return [
    "-b:v",
    String(bitrate),
    "-maxrate",
    String(bitrate),
    "-bufsize",
    String(bitrate * 2),
  ];
}

// Probe profile names to encoder profile names; anything else lets the encoder choose.
const encoderProfiles: Record<string, Record<string, string>> = {
  h264: {
    constrainedbaseline: "baseline",
    baseline: "baseline",
    main: "main",
    high: "high",
    high10: "high10",
  },
  hevc: { main: "main", main10: "main10" },
};

const tenBitProfiles = new Set(["high10", "main10"]);

const transferFunctions: Record<string, string> = {
  hdr10: "smpte2084",
  "hdr10+": "smpte2084",
  "dolby-vision": "smpte2084",
  hlg: "arib-std-b67",
};

/** Returns the CPU filter chain that tone maps one HDR flavour to 8-bit-ready BT.709. */
export function toneMapFilter(hdr: string) {
  const transfer = transferFunctions[hdr];
  if (transfer === undefined) {
    throw new RangeError(`No tone map for ${hdr}.`);
  }
  // Every stage names its input: zscale finds no conversion path from a
  // frame that is missing a tag.
  return [
    `zscale=tin=${transfer}:pin=bt2020:min=bt2020nc:rin=tv:t=linear:p=bt2020:npl=100`,
    "format=gbrpf32le",
    "zscale=tin=linear:pin=bt2020:p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=tin=linear:pin=bt709:t=bt709:m=bt709:r=tv",
  ].join(",");
}

// A segment length no file reaches: a day.
const oneSegmentSeconds = 86_400;

const seconds = (time: number) => (Math.floor(time * 1e6) / 1e6).toFixed(6);

/** Builds the video args for a run; when forceKeyFrames is given it replaces the timeline boundary list. */
export function videoArguments(
  run: { video: VideoDecision; burnSubtitle?: number },
  forceKeyFrames?: string,
) {
  const video = run.video;
  if (video.action === "copy") {
    const args = ["-map", "0:V:0", "-c:v", "copy"];
    if (video.codec === "hevc") {
      // The muxer writes hev1 on a stream copy; Apple clients need hvc1.
      args.push("-tag:v", "hvc1");
    }
    if (video.stripDolbyVision) {
      args.push("-bsf:v", "dovi_rpu=strip=1");
    }
    return args;
  }
  const encoder = liveEncoders[video.codec];
  if (encoder === undefined) {
    throw new RangeError(`No live encoder for ${video.codec}.`);
  }
  const profile =
    video.profile === null
      ? undefined
      : encoderProfiles[video.codec]?.[video.profile];
  const tenBit =
    (video.profile !== null && tenBitProfiles.has(video.profile)) ||
    (video.codec === "av1" && video.hdr !== "sdr");
  const pixelFormat = tenBit ? "yuv420p10le" : "yuv420p";
  const size = `w=${video.width}:h=${video.height}`;
  const picture = [`scale=${size}`];
  if (video.toneMap !== null) picture.push(toneMapFilter(video.toneMap));
  // overlay blends in 8-bit unless told otherwise, which would flatten a
  // 10-bit picture everywhere, not just under the subtitle.
  const blend = tenBit ? ":format=yuv420p10" : "";
  const graph =
    run.burnSubtitle === undefined
      ? `[0:V:0]${picture.join(",")},format=${pixelFormat}[v]`
      : `[0:V:0]${picture.join(",")}[base];` +
        `[0:s:${run.burnSubtitle}]scale=${size}[subtitle];` +
        `[base][subtitle]overlay=eof_action=pass:repeatlast=0${blend},format=${pixelFormat}[v]`;
  const args = ["-filter_complex", graph, "-map", "[v]", ...encoder];
  if (profile !== undefined) args.push("-profile:v", profile);
  if (video.codec === "h264" && video.level !== null) {
    args.push("-level:v", (video.level / 10).toFixed(1));
  }
  args.push(...rateArguments(video.codec, video.bitrate));
  if (video.maxFrameRate !== null) {
    args.push("-fpsmax", String(video.maxFrameRate));
  }
  if (forceKeyFrames !== undefined) {
    args.push("-force_key_frames:v", forceKeyFrames);
  }
  return args;
}

export function audioArguments(run: {
  audioStream?: number;
  audio?: AudioDecision | null;
}) {
  const audio = run.audio;
  if (audio == null || audio.action === "copy") {
    return [...audioMap(run.audioStream), "-c:a", "copy"];
  }
  const bitrate =
    audio.codec === "eac3" ? audioBitrates.eac3 : audioBitrates.aac;
  return [
    ...audioMap(run.audioStream ?? 0),
    "-c:a",
    audio.codec,
    "-ac",
    String(audio.channels),
    "-b:a",
    String(bitrate),
  ];
}

/** Builds the ffmpeg argument list for a live run: copy or re-encode per Stream, cut on the timeline. */
export function liveRunArguments(run: LiveRun) {
  if (run.boundariesSeconds.length < 2) {
    throw new RangeError("A timeline needs at least two boundaries.");
  }
  if (
    !Number.isInteger(run.startIndex) ||
    run.startIndex < 0 ||
    run.startIndex >= run.boundariesSeconds.length - 1
  ) {
    throw new RangeError("Segment index out of range.");
  }
  if (run.burnSubtitle !== undefined && run.video.action === "copy") {
    throw new RangeError("Burning a subtitle needs a video re-encode.");
  }
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (run.readRate !== undefined) {
    args.push(
      "-readrate",
      String(run.readRate.rate),
      "-readrate_initial_burst",
      String(run.readRate.initialBurstSeconds),
    );
  }
  if (run.startIndex > 0) {
    // The seek time is ceiled so a keyframe exactly at the boundary stays in the run.
    const boundary = run.boundariesSeconds[run.startIndex] ?? 0;
    args.push("-seek_timestamp", "1", "-ss", `${Math.ceil(boundary * 1e6)}us`);
  }
  // Only the boundaries this run reaches: ffmpeg consumes one forced time per
  // frame, so earlier ones would turn the run's first frames into keyframes.
  const forced = run.boundariesSeconds.slice(run.startIndex + 1, -1);
  args.push(
    "-i",
    run.inputPath,
    ...videoArguments(
      run,
      forced.length > 0 ? forced.map(seconds).join(",") : undefined,
    ),
    ...audioArguments(run),
    "-sn",
    "-dn",
    "-copyts",
    "-avoid_negative_ts",
    "disabled",
    "-f",
    "segment",
    "-segment_format",
    "mp4",
    // Every segment file carries its own header: the mp4 muxer can write an
    // AC-3 or E-AC-3 header only after the first packet (delay_moov), which a
    // shared header file cannot wait for. The server splits the header off.
    "-segment_format_options",
    "movflags=+frag_keyframe+empty_moov+default_base_moof+frag_discont+delay_moov+skip_trailer:avoid_negative_ts=disabled",
    "-individual_header_trailer",
    "1",
  );
  // The segment muxer measures cut times from the run's first frame and takes
  // the list from its first entry; -segment_start_number only names files. So
  // a run lists the boundaries after its start, relative to that start.
  const start = run.boundariesSeconds[run.startIndex] ?? 0;
  const cuts = run.boundariesSeconds.slice(run.startIndex + 1, -1);
  if (cuts.length > 0) {
    // Cut times are floored so a keyframe at the boundary falls inside its segment.
    args.push(
      "-segment_times",
      cuts.map((time) => `${Math.floor((time - start) * 1e6)}us`).join(","),
    );
    if (run.video.action === "transcode") {
      // A re-encode's first frame can land up to a frame after its boundary,
      // on a frame-rate cap's grid, which moves every cut that much late.
      // Its only keyframes are the forced ones, so the muxer may take the one
      // at each boundary from anywhere within half the shortest segment.
      const shortest = Math.min(
        ...cuts.map(
          (time, index) =>
            time - (run.boundariesSeconds[run.startIndex + index] ?? 0),
        ),
      );
      args.push("-segment_time_delta", `${Math.round(shortest * 5e5)}us`);
    }
  } else {
    // Without a list the muxer cuts every 2 s at any keyframe; the run's one
    // segment must run to the end.
    args.push("-segment_time", String(oneSegmentSeconds));
  }
  args.push(
    "-segment_start_number",
    String(run.startIndex),
    "-segment_list",
    `${run.directory}/segments.m3u8`,
    "-segment_list_type",
    "m3u8",
    `${run.directory}/%d.m4s`,
  );
  return args;
}

/** Reads the segment indexes ffmpeg's own m3u8 list declares complete. */
export function parseSegmentList(text: string) {
  const indexes: number[] = [];
  for (const line of text.split("\n")) {
    const match = /^(\d+)\.m4s$/.exec(line.trim());
    const index = match?.[1];
    if (index !== undefined) {
      indexes.push(Number(index));
    }
  }
  return indexes;
}

/** Returns the byte offset of the first `moof` box: everything before it is the segment's own init. */
export async function fragmentOffset(path: string) {
  const file = Bun.file(path);
  let offset = 0;
  while (offset + 8 <= file.size) {
    const header = new DataView(
      (await file.slice(offset, offset + 8).bytes()).buffer,
    );
    const size = header.getUint32(0);
    const type = String.fromCharCode(
      header.getUint8(4),
      header.getUint8(5),
      header.getUint8(6),
      header.getUint8(7),
    );
    if (type === "moof") return offset;
    if (size < 8) break;
    offset += size;
  }
  throw new Error(`No fragment in ${path}.`);
}

/** A finished segment file and where its fragment starts. */
export type ReadySegment = { index: number; fragmentOffset: number };

/** A live ffmpeg run: ready events per finished segment, then an exit. */
export type RunHandle = {
  pid: number;
  /** Resolves with the exit code, or null when killed by signal. */
  exited: Promise<number | null>;
  /** Kills ffmpeg with SIGKILL and waits for it to exit. Safe to call twice. */
  kill(): Promise<void>;
};

/** Spawns ffmpeg for a run and reports each finished segment through onReady. */
export function startLiveRun(
  run: LiveRun,
  onReady: (segments: ReadySegment[]) => void,
): RunHandle {
  const args = liveRunArguments(run);
  const listPath = `${run.directory}/segments.m3u8`;
  const reported = new Set<number>();
  let killed = false;
  let reads: Promise<void> = Promise.resolve();

  const readList = () => {
    reads = reads.then(async () => {
      const text = await Bun.file(listPath)
        .text()
        .catch(() => null);
      if (text === null) {
        return;
      }
      const fresh = parseSegmentList(text).filter(
        (index) => !reported.has(index),
      );
      const segments: ReadySegment[] = [];
      for (const index of fresh) {
        reported.add(index);
        segments.push({
          index,
          fragmentOffset: await fragmentOffset(`${run.directory}/${index}.m4s`),
        });
      }
      if (segments.length > 0) {
        onReady(segments);
      }
    });
    // A failed read must not stall the reads queued behind it.
    reads = reads.catch((error: unknown) =>
      console.error(
        JSON.stringify({
          level: "error",
          role: "transcoder",
          message: "run.list_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    return reads;
  };

  const watcher = watch(run.directory, (_event, filename) => {
    if (filename === "segments.m3u8") {
      void readList();
    }
  });

  const spawnFfmpeg = () =>
    Bun.spawn(["ffmpeg", ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof spawnFfmpeg>;
  try {
    proc = spawnFfmpeg();
  } catch (error) {
    // No handle is returned, so nobody else can close the watcher.
    watcher.close();
    throw error;
  }
  const stderr = new Response(proc.stderr).text();

  const exited = (async (): Promise<number | null> => {
    await proc.exited;
    // Close first so no event can queue a read after the drain below.
    watcher.close();
    if (killed) {
      await reads.catch(() => {});
    } else {
      await readList();
    }
    const code = proc.exitCode;
    if (!killed && code !== null && code !== 0) {
      console.error(
        JSON.stringify({
          level: "error",
          role: "transcoder",
          message: "run.failed",
          exitCode: code,
          stderr: (await stderr).trim().slice(-2000),
        }),
      );
    }
    return code;
  })();

  let done = false;
  void exited.then(() => {
    done = true;
  });

  const kill = async () => {
    if (done) {
      return;
    }
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may have exited between the check and the kill.
    }
    await exited;
  };

  return { pid: proc.pid, exited, kill };
}
