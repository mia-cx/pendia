/** Options for {@link createKeyframeFixture}. */
export interface KeyframeFixtureOptions {
  layout?: "start" | "end";
  gop?: number;
}

/** Generate a deterministic 12-second MKV with keyframes every `gop` frames. */
export async function createKeyframeFixture(
  path: string,
  options: KeyframeFixtureOptions = {},
): Promise<void> {
  const { layout = "end", gop = 50 } = options;
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=25:d=12",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(gop),
      "-keyint_min",
      String(gop),
      "-sc_threshold",
      "0",
      "-bf",
      "0",
      ...(layout === "start"
        ? ["-reserve_index_space", "8192", "-cues_to_front", "1"]
        : []),
      path,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, , exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed (${exitCode}): ${stderr.trim()}`);
  }
}

interface FfprobePacket {
  pts_time?: string;
  flags?: string;
}

/** Read a file's video keyframe PTS seconds through an independent ffprobe packet scan. */
export async function ffprobeKeyframeTimes(path: string): Promise<number[]> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_packets",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "json",
      "-i",
      path,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [output, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed (${exitCode}): ${stderr.trim()}`);
  }
  const parsed: { packets?: FfprobePacket[] } = JSON.parse(output);
  return (parsed.packets ?? [])
    .filter((packet) => packet.flags?.includes("K") ?? false)
    .map((packet) => Number(packet.pts_time));
}
