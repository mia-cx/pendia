import { watch } from "node:fs";

/** Everything one ffmpeg remux run needs: the input, the timeline, where to start and where to write. */
export type RemuxRun = {
  inputPath: string;
  boundariesSeconds: readonly number[]; // the Item's timeline, first element 0, last the duration
  startIndex: number; // segment index to start at
  directory: string; // the run directory, created by the caller
  videoCodec: string; // probed codec name, "hevc" gets -tag:v hvc1
  readRate?: { rate: number; initialBurstSeconds: number }; // optional throttle, tests only
  /** The engine decided the client plays the HDR10 base layer of a profile 7 or 8 source. */
  stripDolbyVision?: boolean;
};

/** The input options of a segmenting run: optional throttle, then the seek to its first segment. */
export function inputArguments(
  boundariesSeconds: readonly number[],
  startIndex: number,
  readRate?: RemuxRun["readRate"],
) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (readRate !== undefined) {
    args.push(
      "-readrate",
      String(readRate.rate),
      "-readrate_initial_burst",
      String(readRate.initialBurstSeconds),
    );
  }
  if (startIndex > 0) {
    // The seek time is ceiled so a keyframe exactly at the boundary stays in the run.
    const boundary = boundariesSeconds[startIndex] ?? 0;
    args.push("-seek_timestamp", "1", "-ss", `${Math.ceil(boundary * 1e6)}us`);
  }
  return args;
}

/** Builds the ffmpeg argument list for a remux run. */
export function remuxArguments(run: RemuxRun) {
  const segments = segmentArguments(
    run.boundariesSeconds,
    run.startIndex,
    run.directory,
  );
  const args = inputArguments(
    run.boundariesSeconds,
    run.startIndex,
    run.readRate,
  );
  args.push(
    "-i",
    run.inputPath,
    "-map",
    "0:V:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    "-c",
    "copy",
  );
  if (run.videoCodec === "hevc") {
    // The muxer writes hev1 on a stream copy; Apple clients need hvc1.
    args.push("-tag:v", "hvc1");
  }
  if (run.stripDolbyVision === true) {
    args.push("-bsf:v", "dovi_rpu=strip=1");
  }
  return [...args, ...segments];
}

/** The output options that cut fMP4 segments on the timeline into a directory, with a shared init and ffmpeg's own list. */
export function segmentArguments(
  boundariesSeconds: readonly number[],
  startIndex: number,
  directory: string,
) {
  if (boundariesSeconds.length < 2) {
    throw new RangeError("A timeline needs at least two boundaries.");
  }
  if (
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    startIndex >= boundariesSeconds.length - 1
  ) {
    throw new RangeError("Segment index out of range.");
  }
  const args = [
    "-copyts",
    "-avoid_negative_ts",
    "disabled",
    "-f",
    "segment",
    "-segment_format",
    "mp4",
    "-segment_format_options",
    // Without use_editlist=0 a discontinuous fragment starts its decode time
    // at the first pts, which delays B-frame video by its reorder depth.
    "movflags=+frag_keyframe+empty_moov+default_base_moof+frag_discont:avoid_negative_ts=disabled:use_editlist=0",
    "-individual_header_trailer",
    "0",
    "-segment_header_filename",
    `${directory}/init.mp4`,
  ];
  const interior = cutTimes(boundariesSeconds);
  if (interior !== null) {
    args.push("-segment_times", interior);
  }
  args.push(
    "-segment_start_number",
    String(startIndex),
    "-segment_list",
    `${directory}/segments.m3u8`,
    "-segment_list_type",
    "m3u8",
    `${directory}/%d.m4s`,
  );
  return args;
}

/** The interior timeline boundaries as an ffmpeg time list; null for a one-segment timeline. */
export function cutTimes(boundariesSeconds: readonly number[]) {
  const interior = boundariesSeconds.slice(1, -1);
  if (interior.length === 0) return null;
  // Cut times are floored so a frame at the boundary falls inside its segment.
  return interior.map((time) => `${Math.floor(time * 1e6)}us`).join(",");
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

/** A live ffmpeg run: ready events per finished segment, then an exit. */
export type RunHandle = {
  pid: number;
  /** Resolves with the exit code, or null when killed by signal. */
  exited: Promise<number | null>;
  /** Kills ffmpeg with SIGKILL and waits for it to exit. Safe to call twice. */
  kill(): Promise<void>;
};

/** Spawns ffmpeg for a remux run and reports each finished segment through onReady. */
export function startRemuxRun(
  run: RemuxRun,
  onReady: (indexes: number[]) => void,
): RunHandle {
  return startSegmentRun(
    {
      command: ["ffmpeg", ...remuxArguments(run)],
      directory: run.directory,
      log: { role: "transcoder", message: "remux.failed" },
    },
    onReady,
  );
}

/** A segmenting command, the directory its list lands in, and the log line a failed exit writes. */
export type SegmentRun = {
  command: readonly string[];
  directory: string;
  log: { role: string; message: string };
};

/** Spawns a segmenting ffmpeg command and reports each segment its own list declares finished. */
export function startSegmentRun(
  run: SegmentRun,
  onReady: (indexes: number[]) => void,
): RunHandle {
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
      for (const index of fresh) {
        reported.add(index);
      }
      if (fresh.length > 0) {
        onReady(fresh);
      }
    });
    return reads;
  };

  const watcher = watch(run.directory, (_event, filename) => {
    if (filename === "segments.m3u8") {
      void readList();
    }
  });

  const spawnFfmpeg = () =>
    Bun.spawn([...run.command], {
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
          ...run.log,
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
