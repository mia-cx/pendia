import { describe, expect, test } from "bun:test";
import {
  cpuTrialArguments,
  hardwareBackends,
  hardwareTrialArguments,
  runStartupTrial,
  toneMapTrialArguments,
} from "./trial.ts";

const picture = ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2"];
const head = ["-hide_banner", "-loglevel", "error", "-nostdin"];

describe("trial arguments", () => {
  test("a CPU trial encodes 2 s with the live settings and forces a keyframe at 1 s", () => {
    expect(cpuTrialArguments("h264", "/tmp/trial/h264.mkv")).toEqual([
      ...head,
      ...picture,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-bf",
      "0",
      "-x264-params",
      "scenecut=0:keyint=infinite",
      "-b:v",
      "1000000",
      "-maxrate",
      "1000000",
      "-bufsize",
      "2000000",
      "-force_key_frames:v",
      "1",
      "-f",
      "matroska",
      "-y",
      "/tmp/trial/h264.mkv",
    ]);
    // The live AV1 rate control: a target bitrate, no ceiling.
    const av1 = cpuTrialArguments("av1", "/tmp/trial/av1.mkv");
    expect(av1).toContain("libsvtav1");
    expect(av1).not.toContain("-maxrate");
    expect(() => cpuTrialArguments("vp9", "/tmp/trial/vp9.mkv")).toThrow(
      RangeError,
    );
  });

  test("a tone map trial runs the live filter on a 10-bit picture", () => {
    const args = toneMapTrialArguments("hlg");
    expect(args.slice(0, head.length + picture.length)).toEqual([
      ...head,
      ...picture,
    ]);
    const filter = args[args.indexOf("-vf") + 1];
    expect(
      filter?.startsWith("format=yuv420p10le,zscale=tin=arib-std-b67"),
    ).toBe(true);
    expect(filter?.endsWith(",format=yuv420p")).toBe(true);
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  test("a hardware trial opens the device before the input and uploads frames", () => {
    const vaapi = hardwareBackends.find((backend) => backend.name === "vaapi");
    if (vaapi === undefined) throw new Error("Expected a vaapi backend.");
    expect(hardwareTrialArguments(vaapi, "hevc_vaapi")).toEqual([
      ...head,
      "-init_hw_device",
      "vaapi=hw:/dev/dri/renderD128",
      "-filter_hw_device",
      "hw",
      ...picture,
      "-vf",
      "format=nv12,hwupload",
      "-c:v",
      "hevc_vaapi",
      "-f",
      "null",
      "-",
    ]);
  });

  test("hardware backends are tried in the engine's preference order", () => {
    expect(hardwareBackends.map((backend) => backend.name)).toEqual([
      "qsv",
      "vaapi",
      "nvenc",
      "vulkan",
    ]);
  });
});

describe("runStartupTrial", () => {
  test("records the CPU first with H.264, and hardware only with a passing codec", async () => {
    const backends = await runStartupTrial();
    const [cpu, ...hardware] = backends;
    expect(cpu?.name).toBe("cpu");
    expect(cpu?.codecs).toContain("h264");
    for (const backend of hardware) {
      expect(backend.name).not.toBe("cpu");
      expect(backend.codecs.length).toBeGreaterThan(0);
      expect(backend.toneMapping).toEqual([]);
    }
  }, 30_000);
});
