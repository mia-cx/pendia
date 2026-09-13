import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Options for {@link createVideoFixture}. */
export interface VideoFixtureOptions {
  width?: number;
  height?: number;
  chapters?: boolean;
}

/** Generate a short real MKV with h264 video, AAC audio and SRT subtitles. */
export async function createVideoFixture(
  path: string,
  options: VideoFixtureOptions = {},
): Promise<void> {
  const { width = 1920, height = 1080, chapters = false } = options;
  const subtitlesPath = `${path}.srt`;
  const metadataPath = `${path}.ffmetadata`;
  await writeFile(subtitlesPath, "1\n00:00:00,000 --> 00:00:00,800\nFixture\n");
  await writeFile(
    metadataPath,
    chapters
      ? ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n"
      : ";FFMETADATA1\n",
  );
  try {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${width}x${height}:r=2:d=1`,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-f",
        "srt",
        "-i",
        subtitlesPath,
        "-f",
        "ffmetadata",
        "-i",
        metadataPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:s:0",
        "-map_metadata",
        "3",
        "-map_chapters",
        "3",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-c:s",
        "srt",
        "-metadata:s:a:0",
        "language=eng",
        "-metadata:s:s:0",
        "language=nld",
        "-disposition:a:0",
        "default",
        "-disposition:s:0",
        "forced",
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
  } finally {
    await rm(subtitlesPath, { force: true });
    await rm(metadataPath, { force: true });
  }
}

/** Run `run` inside a fresh temporary directory and always remove it. */
export async function withVideoFixture<T>(
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pendia-video-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
