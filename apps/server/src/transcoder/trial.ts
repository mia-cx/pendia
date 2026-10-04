import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscoderBackend } from "../db/schema/index.ts";
import { liveEncoders, rateArguments, toneMapFilter } from "./live-run.ts";

// Two seconds of a small moving picture: enough to open and drive an encoder.
const trialPicture = ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2"];
const quiet = ["-hide_banner", "-loglevel", "error", "-nostdin"];
const discard = ["-f", "null", "-"];

// One tone map trial per transfer function: the PQ flavours share a filter.
const toneMapGroups = [
  { filter: "hdr10", flavours: ["hdr10", "hdr10+", "dolby-vision"] },
  { filter: "hlg", flavours: ["hlg"] },
] as const;

/** The hardware backends a trial tries, each behind the device node it needs. */
export const hardwareBackends = [
  {
    name: "qsv",
    device: "/dev/dri/renderD128",
    input: [
      "-init_hw_device",
      "qsv=hw,child_device=/dev/dri/renderD128",
      "-filter_hw_device",
      "hw",
    ],
    upload: "format=nv12,hwupload=extra_hw_frames=64",
    encoders: { h264: "h264_qsv", hevc: "hevc_qsv", av1: "av1_qsv" },
  },
  {
    name: "vaapi",
    device: "/dev/dri/renderD128",
    input: [
      "-init_hw_device",
      "vaapi=hw:/dev/dri/renderD128",
      "-filter_hw_device",
      "hw",
    ],
    upload: "format=nv12,hwupload",
    encoders: { h264: "h264_vaapi", hevc: "hevc_vaapi", av1: "av1_vaapi" },
  },
  {
    name: "nvenc",
    device: "/dev/nvidia0",
    input: [],
    upload: "format=yuv420p",
    encoders: { h264: "h264_nvenc", hevc: "hevc_nvenc", av1: "av1_nvenc" },
  },
  {
    name: "vulkan",
    device: "/dev/dri/renderD128",
    input: ["-init_hw_device", "vulkan=hw", "-filter_hw_device", "hw"],
    upload: "format=nv12,hwupload",
    encoders: { h264: "h264_vulkan", hevc: "hevc_vulkan" },
  },
] as const;

// A CPU trial asks for one keyframe here, the way a live run forces one per
// boundary, at a bitrate the live rate control accepts.
const forcedSecond = 1;
const trialBitrate = 1_000_000;

/** Builds the 2 s CPU encode of one codec with the live settings and one forced keyframe, written as Matroska to a file. */
export function cpuTrialArguments(codec: string, outputPath: string) {
  const encoder = liveEncoders[codec];
  if (encoder === undefined) {
    throw new RangeError(`No live encoder for ${codec}.`);
  }
  return [
    ...quiet,
    ...trialPicture,
    ...encoder,
    ...rateArguments(codec, trialBitrate),
    "-force_key_frames:v",
    String(forcedSecond),
    "-f",
    "matroska",
    "-y",
    outputPath,
  ];
}

/** Builds the 2 s CPU tone map of one HDR flavour from a 10-bit picture. */
export function toneMapTrialArguments(hdr: string) {
  return [
    ...quiet,
    ...trialPicture,
    "-vf",
    `format=yuv420p10le,${toneMapFilter(hdr)},format=yuv420p`,
    ...discard,
  ];
}

/** Builds the 2 s encode of one codec on one hardware backend. */
export function hardwareTrialArguments(
  backend: (typeof hardwareBackends)[number],
  encoder: string,
) {
  return [
    ...quiet,
    ...backend.input,
    ...trialPicture,
    "-vf",
    backend.upload,
    "-c:v",
    encoder,
    ...discard,
  ];
}

// A trial process that hangs fails its trial instead of holding startup.
const trialTimeoutMs = 30_000;

/** Runs one trial command; its output when it exits cleanly in time, else null. */
const run = async (command: string[]) => {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: trialTimeoutMs,
    killSignal: "SIGKILL",
  });
  const [output, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return code === 0 ? output : null;
};

const succeeds = async (args: string[]) =>
  (await run(["ffmpeg", ...args])) !== null;

// A live run cuts segments on forced keyframes, so an encoder that ignores
// them with the live settings cannot serve one. SVT-AV1 1.7 under ffmpeg 6.1
// is one: it honours forced keyframes only in CRF mode.
const forcesKeyframe = async (codec: string) => {
  const directory = await mkdtemp(join(tmpdir(), "pendia-trial-"));
  const path = join(directory, `${codec}.mkv`);
  try {
    if (!(await succeeds(cpuTrialArguments(codec, path)))) return false;
    const packets = await run([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "csv=p=0",
      "-i",
      path,
    ]);
    return (packets ?? "").split("\n").some((line) => {
      const [pts, flags] = line.split(",");
      return (
        flags?.startsWith("K") === true &&
        Math.abs(Number(pts) - forcedSecond) < 0.05
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Runs the startup trial and returns the node's capability table. A CPU codec
 * passes when its live encoder writes the keyframe the trial forces; the CPU
 * must pass at least one, or the trial throws. A hardware backend is recorded
 * when its device exists and it encodes at least one codec.
 */
export async function runStartupTrial(): Promise<TranscoderBackend[]> {
  const codecs = Object.keys(liveEncoders);
  const passing = async <T>(trials: [T, () => Promise<boolean>][]) => {
    const results = await Promise.all(trials.map(([, trial]) => trial()));
    return trials.filter((_, index) => results[index]).map(([value]) => value);
  };
  const [cpuCodecs, toneMapping, hardware] = await Promise.all([
    passing(codecs.map((codec) => [codec, () => forcesKeyframe(codec)])),
    passing(
      toneMapGroups.map((group) => [
        group.flavours,
        () => succeeds(toneMapTrialArguments(group.filter)),
      ]),
    ),
    Promise.all(
      hardwareBackends.map(async (backend) => {
        if (!(await exists(backend.device))) return [];
        const passed = await passing(
          Object.entries(backend.encoders).map(([codec, encoder]) => [
            codec,
            () => succeeds(hardwareTrialArguments(backend, encoder)),
          ]),
        );
        // Hardware tone mapping is not trialled: only the CPU path tone maps today.
        return passed.length === 0
          ? []
          : [{ name: backend.name, codecs: passed, toneMapping: [] }];
      }),
    ),
  ]);
  if (cpuCodecs.length === 0) {
    throw new Error("The CPU trial encoded no codec.");
  }
  return [
    { name: "cpu", codecs: cpuCodecs, toneMapping: toneMapping.flat() },
    ...hardware.flat(),
  ];
}
