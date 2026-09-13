import { extname } from "node:path";

/** Options for {@link createKeyframeFixture}. */
export interface KeyframeFixtureOptions {
  layout?: "start" | "end";
  bFrames?: boolean;
  fragmented?: boolean;
  audioFirst?: boolean;
  gop?: number;
}

/** Generate a deterministic 12-second video fixture, MKV or MP4 by extension. */
export async function createKeyframeFixture(
  path: string,
  options: KeyframeFixtureOptions = {},
): Promise<void> {
  const {
    layout = "end",
    bFrames = false,
    fragmented = false,
    audioFirst = false,
    gop = 50,
  } = options;
  const mp4 = extname(path).toLowerCase() === ".mp4";
  const args = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=25:d=12",
    ...(audioFirst
      ? [
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=48000:cl=stereo",
          "-map",
          "1:a:0",
          "-map",
          "0:v:0",
        ]
      : ["-an"]),
    "-c:v",
    "libx264",
    "-preset",
    bFrames ? "medium" : "ultrafast",
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
    bFrames ? "2" : "0",
    ...(audioFirst ? ["-c:a", "aac", "-t", "12"] : []),
    ...(mp4
      ? fragmented
        ? ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"]
        : layout === "start"
          ? ["-movflags", "+faststart"]
          : []
      : layout === "start"
        ? ["-reserve_index_space", "8192", "-cues_to_front", "1"]
        : []),
    path,
  ];
  const proc = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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
