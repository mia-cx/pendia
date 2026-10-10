import { rename, rm, stat } from "node:fs/promises";

const maxCachedSubtitleBytes = 32 * 1024 * 1024;
const maxCachedSubtitleTracks = 128;
const subtitleCache = new Map<string, { text: string; bytes: number }>();
let cachedSubtitleBytes = 0;

async function cachedSubtitle(
  path: string,
  index: number,
  format: "webvtt" | "ass",
  signal?: AbortSignal,
) {
  const file = await stat(path, { bigint: true });
  const key = `${path}:${index}:${format}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  const cached = subtitleCache.get(key);
  if (cached !== undefined) {
    subtitleCache.delete(key);
    subtitleCache.set(key, cached);
    return cached.text;
  }
  const text = await extractSubtitle(path, index, format, signal);
  // Another segment may have finished the same extraction while this one ran.
  const populated = subtitleCache.get(key);
  if (populated !== undefined) return populated.text;
  const bytes = Buffer.byteLength(text);
  if (bytes > maxCachedSubtitleBytes) return text;
  while (
    cachedSubtitleBytes + bytes > maxCachedSubtitleBytes ||
    subtitleCache.size >= maxCachedSubtitleTracks
  ) {
    const oldest = subtitleCache.entries().next().value;
    if (oldest === undefined) break;
    subtitleCache.delete(oldest[0]);
    cachedSubtitleBytes -= oldest[1].bytes;
  }
  subtitleCache.set(key, { text, bytes });
  cachedSubtitleBytes += bytes;
  return text;
}

/** A subtitle interval in source seconds; rebased output starts at zero unless timestamps are copied. */
export type SubtitleWindow = {
  startSeconds?: number;
  endSeconds?: number;
  copyTimestamps?: boolean;
  addTimeMap?: boolean;
};

const clockSeconds = (time: string) =>
  time.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);

function subtitleClock(seconds: number) {
  const milliseconds = Math.round(seconds * 1000);
  return `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, "0")}:${String(Math.floor(milliseconds / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

function subtitleInterval(window: SubtitleWindow) {
  const start = window.startSeconds ?? 0;
  const end = window.endSeconds ?? Infinity;
  if (
    !Number.isFinite(start) ||
    start < 0 ||
    end < start ||
    (end !== Infinity && !Number.isFinite(end))
  )
    throw new RangeError("Invalid subtitle interval.");
  const offset = window.copyTimestamps ? 0 : start;
  return { start, end, offset };
}

const cueTiming =
  /^((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})(.*)$/m;

/** Reads text cue events from converted WebVTT in source seconds. */
export function webvttEvents(text: string) {
  return text
    .trimEnd()
    .split(/\r?\n\r?\n/)
    .slice(1)
    .flatMap((block) => {
      const match = cueTiming.exec(block);
      if (match === null) return [];
      return [
        {
          id: block.slice(0, match.index).trim(),
          text: block.slice(match.index + match[0].length).trim(),
          startSeconds: clockSeconds(match[1] ?? ""),
          endSeconds: clockSeconds(match[2] ?? ""),
        },
      ];
    });
}

function windowedWebvtt(text: string, window: SubtitleWindow) {
  const { start, end, offset } = subtitleInterval(window);
  const blocks = text.trimEnd().split(/\r?\n\r?\n/);
  const cues = blocks.slice(1).flatMap((block) => {
    const match = cueTiming.exec(block);
    if (match === null) return [];
    const from = Math.max(clockSeconds(match[1] ?? ""), start);
    const to = Math.min(clockSeconds(match[2] ?? ""), end);
    if (to <= from) return [];
    return [
      block.replace(
        match[0],
        `${subtitleClock(from - offset)} --> ${subtitleClock(to - offset)}${match[3] ?? ""}`,
      ),
    ];
  });
  const map = window.addTimeMap
    ? `\nX-TIMESTAMP-MAP=LOCAL:${subtitleClock(start - offset)},MPEGTS:${Math.round(start * 90_000)}`
    : "";
  return `WEBVTT${map}\n\n${cues.join("\n\n")}\n`;
}

function assClock(seconds: number) {
  const centiseconds = Math.round(seconds * 100);
  return `${Math.floor(centiseconds / 360_000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, "0")}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}

function windowedAss(text: string, window: SubtitleWindow) {
  const { start, end, offset } = subtitleInterval(window);
  // FFmpeg emits the standard Layer, Start, End, ... dialogue fields. Keep all
  // styles, headers, and override tags while changing only those two clocks.
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^Dialogue: ([^,]+),([^,]+),([^,]+),(.*)$/.exec(line);
      if (match === null) return [line];
      const from = Math.max(clockSeconds(match[2] ?? ""), start);
      const to = Math.min(clockSeconds(match[3] ?? ""), end);
      if (to <= from) return [];
      return [
        `Dialogue: ${match[1]},${assClock(from - offset)},${assClock(to - offset)},${match[4]}`,
      ];
    })
    .join("\n");
}

/** Converts a text track to WebVTT, SRT, or ASS after applying its source-time interval. */
export async function readSubtitle(
  inputPath: string,
  subtitleIndex: number,
  format: "vtt" | "srt" | "ass",
  window: SubtitleWindow = {},
  signal?: AbortSignal,
) {
  if (format === "ass")
    return windowedAss(
      await cachedSubtitle(inputPath, subtitleIndex, "ass", signal),
      window,
    );
  // HLS asks for many windows of one track. Extract once per file revision,
  // rather than reading an entire film again for each six-second segment.
  const text = windowedWebvtt(
    await cachedSubtitle(inputPath, subtitleIndex, "webvtt", signal),
    window,
  );
  if (format === "vtt") return text;
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "webvtt",
      "-i",
      "pipe:0",
      "-map",
      "0:s:0",
      "-c:s",
      format,
      "-f",
      format,
      "pipe:1",
    ],
    { stdin: new Blob([text]), stdout: "pipe", stderr: "pipe", signal },
  );
  const [converted, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Subtitle conversion failed (${code}): ${stderr.trim().slice(-2000)}`,
    );
  return converted;
}

/** Builds the ffmpeg arguments that convert one text subtitle Stream to WebVTT, keeping source timestamps. */
export function webvttArguments(
  inputPath: string,
  subtitleIndex: number,
  outputPath: string,
) {
  return subtitleArguments(inputPath, subtitleIndex, outputPath, "webvtt");
}

function subtitleArguments(
  inputPath: string,
  subtitleIndex: number,
  outputPath: string,
  format: "webvtt" | "ass",
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
    format,
    "-f",
    format,
    outputPath,
  ];
}

/** Converts one text subtitle Stream to WebVTT in memory; aborting the signal kills ffmpeg. */
export async function readWebvtt(
  inputPath: string,
  subtitleIndex: number,
  signal?: AbortSignal,
) {
  return extractSubtitle(inputPath, subtitleIndex, "webvtt", signal);
}

async function extractSubtitle(
  inputPath: string,
  subtitleIndex: number,
  format: "webvtt" | "ass",
  signal?: AbortSignal,
) {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      ...subtitleArguments(inputPath, subtitleIndex, "pipe:1", format),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal },
  );
  const [text, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `${format} conversion failed (${code}): ${stderr.trim().slice(-2000)}`,
    );
  return text;
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
