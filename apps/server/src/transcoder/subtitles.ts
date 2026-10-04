import { rename, rm } from "node:fs/promises";

/** Builds the ffmpeg arguments that convert one text subtitle Stream to WebVTT, keeping source timestamps. */
export function webvttArguments(
  inputPath: string,
  subtitleIndex: number,
  outputPath: string,
) {
  if (!Number.isInteger(subtitleIndex) || subtitleIndex < 0) {
    throw new RangeError("Subtitle index out of range.");
  }
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    // Segments keep source timestamps, so cues must too.
    "-copyts",
    "-i",
    inputPath,
    "-map",
    `0:s:${subtitleIndex}`,
    "-c:s",
    "webvtt",
    "-f",
    "webvtt",
    outputPath,
  ];
}

/** A running WebVTT conversion: done settles when the file is in place or the conversion failed. */
export type Conversion = { done: Promise<void>; kill(): void };

/** Converts one text subtitle Stream to a WebVTT file, written beside it and renamed into place when complete. */
export function convertToWebvtt(
  inputPath: string,
  subtitleIndex: number,
  outputPath: string,
): Conversion {
  const partial = `${outputPath}.partial`;
  const proc = Bun.spawn(
    ["ffmpeg", ...webvttArguments(inputPath, subtitleIndex, partial)],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const stderr = new Response(proc.stderr).text();
  const done = (async () => {
    const code = await proc.exited;
    if (code !== 0) {
      await rm(partial, { force: true });
      throw new Error(
        `WebVTT conversion failed (${code}): ${(await stderr).trim().slice(-2000)}`,
      );
    }
    await rename(partial, outputPath);
  })();
  return {
    done,
    kill() {
      proc.kill("SIGKILL");
    },
  };
}
