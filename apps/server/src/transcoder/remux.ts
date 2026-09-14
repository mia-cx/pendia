import { watch } from "node:fs";

/** Everything one ffmpeg remux run needs: the input, the timeline, where to start and where to write. */
export type RemuxRun = {
  inputPath: string;
  boundariesSeconds: readonly number[]; // the Item's timeline, first element 0, last the duration
  startIndex: number; // segment index to start at
  directory: string; // the run directory, created by the caller
  readRate?: { rate: number; initialBurstSeconds: number }; // optional throttle, tests only
  /** The engine decided the client plays the HDR10 base layer of a profile 7 or 8 source. */
  stripDolbyVision?: boolean;
};

/** Builds the ffmpeg argument list for a remux run. */
export function remuxArguments(run: RemuxRun) {
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
  if (run.stripDolbyVision === true) {
    args.push("-bsf:v", "dovi_rpu=strip=1");
  }
  args.push(
    "-copyts",
    "-avoid_negative_ts",
    "disabled",
    "-f",
    "segment",
    "-segment_format",
    "mp4",
    "-segment_format_options",
    "movflags=+frag_keyframe+empty_moov+default_base_moof+frag_discont:avoid_negative_ts=disabled",
    "-individual_header_trailer",
    "0",
    "-segment_header_filename",
    `${run.directory}/init.mp4`,
  );
  const interior = run.boundariesSeconds.slice(1, -1);
  if (interior.length > 0) {
    // Cut times are floored so a keyframe at the boundary falls inside its segment.
    args.push(
      "-segment_times",
      interior.map((time) => `${Math.floor(time * 1e6)}us`).join(","),
    );
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

/** A live ffmpeg run: ready events per finished segment, then an exit. */
export type RunHandle = {
  pid: number;
  /** Resolves with the exit code, or null when killed by signal. */
  exited: Promise<number | null>;
  /** Kills ffmpeg with SIGKILL and waits for it to exit. Safe to call twice. */
  kill(): Promise<void>;
};

/** Spawns ffmpeg for a run and reports each finished segment through onReady. */
export function startRemuxRun(
  run: RemuxRun,
  onReady: (indexes: number[]) => void,
): RunHandle {
  const args = remuxArguments(run);
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

  const proc = Bun.spawn(["ffmpeg", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
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
          message: "remux.failed",
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
