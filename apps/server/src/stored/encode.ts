import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { hlsCopyAudio } from "../playback/decisions.ts";
import { segmentCount } from "../playback/playlists.ts";
import {
  cutTimes,
  inputArguments,
  type RemuxRun,
  segmentArguments,
  startSegmentRun,
} from "../transcoder/remux.ts";
import type { Rung } from "./policy.ts";

/** The bitrate of the AAC stereo track an encoded rung carries. */
export const storedAudioBitrate = 160_000;

/** The source facts a store run encodes from. */
export type StoreSource = {
  codec: string;
  hdr: string;
  audioCodec: string | null;
};

/** One rung of one source: the input, its timeline, the rung and where it lands. */
export type StoreRun = {
  inputPath: string;
  boundariesSeconds: readonly number[];
  timelineId: string;
  rung: Rung;
  source: StoreSource;
  folder: string; // absolute `<source file>.pendia/<rung>`
  readRate?: RemuxRun["readRate"]; // tests only
};

// A shared init cannot hold AC-3 or E-AC-3: the muxer needs their first
// packet before it can write the moov.
const sharedInitAudio = new Set(
  [...hlsCopyAudio].filter((codec) => codec !== "ac3" && codec !== "eac3"),
);

/** Returns whether a rung carries the source's first audio track as is: only the remux, and only a codec a shared init holds. */
export function copiesAudio(rung: Rung, source: StoreSource) {
  return (
    !("height" in rung) &&
    source.audioCodec !== null &&
    sharedInitAudio.has(source.audioCodec)
  );
}

const toneMap =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

/** Builds the ffmpeg arguments for one store run from a segment index into a directory. */
export function storeArguments(
  run: StoreRun,
  startIndex: number,
  directory: string,
) {
  const segments = segmentArguments(
    run.boundariesSeconds,
    startIndex,
    directory,
  );
  const args = [
    ...inputArguments(run.boundariesSeconds, startIndex, run.readRate),
    "-i",
    run.inputPath,
    "-map",
    "0:V:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
  ];
  const audio = copiesAudio(run.rung, run.source)
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", String(storedAudioBitrate), "-ac", "2"];
  if (!("height" in run.rung)) {
    args.push("-c:v", "copy");
    // The muxer writes hev1 on a stream copy; Apple clients need hvc1.
    if (run.source.codec === "hevc") args.push("-tag:v", "hvc1");
    return [...args, ...audio, ...segments];
  }
  const filters = [`scale=-2:${run.rung.height}`];
  if (run.source.hdr !== "sdr") filters.push(toneMap);
  filters.push("format=yuv420p");
  args.push(
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-maxrate",
    String(run.rung.bitrate),
    "-bufsize",
    String(run.rung.bitrate * 2),
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
  );
  // Keyframes land on the timeline, so every cut starts a closed GOP. ffmpeg
  // spends one forced time per frame, so a resumed run lists only later cuts.
  const keyframes = cutTimes(run.boundariesSeconds.slice(startIndex));
  if (keyframes !== null) args.push("-force_key_frames", keyframes);
  return [...args, ...audio, ...segments];
}

/** The manifest a complete rung folder carries, written last. */
export const StoreManifest = Schema.Struct({
  timelineId: Schema.String,
  rung: Schema.String,
  segments: Schema.Array(Schema.String),
  complete: Schema.Literal(true),
});

const manifestName = "manifest.json";
const initName = "init.mp4";
const rungName = "rung.json";
const segmentName = (index: number) => `${index}.m4s`;

/** Reads a rung folder's manifest; null when it is missing or unreadable. */
export async function readStoreManifest(folder: string) {
  const text = await Bun.file(join(folder, manifestName))
    .text()
    .catch(() => null);
  if (text === null) return null;
  try {
    return Schema.decodeUnknownSync(StoreManifest)(JSON.parse(text));
  } catch {
    return null;
  }
}

async function presentSegments(folder: string, count: number) {
  const names = await readdir(folder);
  const present = new Set<number>();
  for (const name of names) {
    const index = /^(\d+)\.m4s$/.exec(name)?.[1];
    if (index !== undefined && Number(index) < count)
      present.add(Number(index));
  }
  return present;
}

async function writeManifest(run: StoreRun, count: number) {
  const manifest: typeof StoreManifest.Type = {
    timelineId: run.timelineId,
    rung: run.rung.name,
    segments: Array.from({ length: count }, (_, index) => segmentName(index)),
    complete: true,
  };
  const temporary = join(run.folder, `${manifestName}.tmp`);
  await Bun.write(temporary, JSON.stringify(manifest));
  await rename(temporary, join(run.folder, manifestName));
}

/** How a store run ended: every segment and the manifest are on disk, or it stopped first. */
export type StoreOutcome = "complete" | "stopped";

/** Runs ffmpeg under nice into the rung folder, resuming at the first missing segment, until complete or aborted. */
export async function runStore(
  run: StoreRun,
  signal: AbortSignal,
): Promise<StoreOutcome> {
  const count = segmentCount(run.boundariesSeconds);
  const manifest = await readStoreManifest(run.folder);
  // The folder records the rung definition it was cut for, so an edited
  // height or bitrate under the same name starts the rung over.
  const definition = JSON.stringify(run.rung);
  const sameRung =
    (await Bun.file(join(run.folder, rungName))
      .text()
      .catch(() => null)) === definition;
  if (sameRung && manifest?.timelineId === run.timelineId) return "complete";
  const initPath = join(run.folder, initName);
  // A folder cut on another timeline or rung, or segments without their init, cannot be resumed.
  if (!sameRung || manifest !== null || !(await Bun.file(initPath).exists()))
    await rm(run.folder, { recursive: true, force: true });
  await mkdir(run.folder, { recursive: true });
  await Bun.write(join(run.folder, rungName), definition);
  const present = await presentSegments(run.folder, count);
  const start = Array.from({ length: count }, (_, index) => index).find(
    (index) => !present.has(index),
  );
  if (start === undefined) {
    await writeManifest(run, count);
    return "complete";
  }
  if (signal.aborted) return "stopped";

  const partial = join(run.folder, ".partial");
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial);
  let moves = Promise.resolve();
  let failure: unknown = null;
  let initChecked = false;
  let initChanged = false;
  const handle = startSegmentRun(
    {
      command: [
        "nice",
        "-n",
        "19",
        "ffmpeg",
        ...storeArguments(run, start, partial),
      ],
      directory: partial,
      log: { role: "worker", message: "store.failed" },
    },
    (indexes) => {
      moves = moves
        .then(async () => {
          if (failure !== null) return;
          if (!initChecked) {
            initChecked = true;
            const fresh = await Bun.file(join(partial, initName)).bytes();
            if (!(await Bun.file(initPath).exists())) {
              await rename(join(partial, initName), initPath);
            } else if (
              !Buffer.from(await Bun.file(initPath).bytes()).equals(fresh)
            ) {
              initChanged = true;
              throw new Error(
                "The encoder output changed between runs; the rung starts over.",
              );
            }
          }
          for (const index of indexes) {
            const from = join(partial, segmentName(index));
            // A segment already present is never rewritten.
            if (present.has(index)) {
              await rm(from, { force: true });
              continue;
            }
            await rename(from, join(run.folder, segmentName(index)));
            present.add(index);
          }
          // The rest of the run would only rewrite present segments.
          if (present.size === count) void handle.kill();
        })
        .catch((error: unknown) => {
          failure = error;
          void handle.kill();
        });
    },
  );
  const abort = () => void handle.kill();
  signal.addEventListener("abort", abort, { once: true });
  let code: number | null;
  try {
    code = await handle.exited;
    await moves;
  } finally {
    signal.removeEventListener("abort", abort);
    await rm(partial, { recursive: true, force: true });
  }
  if (failure !== null) {
    // Segments cut against another init would not decode together.
    if (initChanged) await rm(run.folder, { recursive: true, force: true });
    throw failure;
  }
  if (present.size < count) {
    if (signal.aborted) return "stopped";
    throw new Error(`ffmpeg exited with ${code} before the rung was complete.`);
  }
  await writeManifest(run, count);
  return "complete";
}
