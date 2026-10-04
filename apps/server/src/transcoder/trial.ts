import { stat } from "node:fs/promises";
import type { TranscoderBackend } from "../db/schema/index.ts";
import { liveEncoders, toneMapFilter } from "./live-run.ts";

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

/** Builds the 2 s CPU encode of one codec with the live encoder settings. */
export function cpuTrialArguments(codec: string) {
  const encoder = liveEncoders[codec];
  if (encoder === undefined) {
    throw new RangeError(`No live encoder for ${codec}.`);
  }
  return [...quiet, ...trialPicture, ...encoder, ...discard];
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

const succeeds = async (args: string[]) => {
  const proc = Bun.spawn(["ffmpeg", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Runs the startup trial and returns the node's capability table. The CPU must
 * encode at least one codec, or the trial throws. A hardware backend is
 * recorded when its device exists and it encodes at least one codec.
 */
export async function runStartupTrial(): Promise<TranscoderBackend[]> {
  const codecs = Object.keys(liveEncoders);
  const passing = async <T>(trials: [T, string[]][]) => {
    const results = await Promise.all(trials.map(([, args]) => succeeds(args)));
    return trials.filter((_, index) => results[index]).map(([value]) => value);
  };
  const [cpuCodecs, toneMapping, hardware] = await Promise.all([
    passing(codecs.map((codec) => [codec, cpuTrialArguments(codec)])),
    passing(
      toneMapGroups.map((group) => [
        group.flavours,
        toneMapTrialArguments(group.filter),
      ]),
    ),
    Promise.all(
      hardwareBackends.map(async (backend) => {
        if (!(await exists(backend.device))) return [];
        const passed = await passing(
          Object.entries(backend.encoders).map(([codec, encoder]) => [
            codec,
            hardwareTrialArguments(backend, encoder),
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
