import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVideoFixture,
  pgsFixtureBox,
} from "../mediums/video-common/fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { ladder } from "../playback/policy.ts";
import { deriveSegmentTimeline } from "../playback/timeline.ts";
import { fragmentOffset, liveRunArguments, startLiveRun } from "./live-run.ts";
import { convertToWebvtt, webvttArguments } from "./subtitles.ts";

describe("webvttArguments", () => {
  test("maps one subtitle Stream to WebVTT with source timestamps", () => {
    expect(webvttArguments("/media/in.mkv", 2, "/scratch/subs-2.vtt")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-copyts",
      "-i",
      "/media/in.mkv",
      "-map",
      "0:s:2",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "/scratch/subs-2.vtt",
    ]);
  });

  test.each([-1, 1.5])("rejects subtitle index %p", (index) => {
    expect(() => webvttArguments("/in.mkv", index, "/out.vtt")).toThrow(
      RangeError,
    );
  });
});

describe("subtitle paths", () => {
  const width = 320;
  const height = 180;
  let dir: string;
  let inputPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thalia-subtitles-"));
    inputPath = join(dir, "input.mkv");
    await createVideoFixture(inputPath, {
      width,
      height,
      durationSeconds: 2,
      frameRate: 25,
      subtitles: ["srt", "ass", "pgs"],
    });
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the fixture carries SRT, ASS and PGS Streams", async () => {
    const probe = await probeVideo(inputPath);
    expect(
      probe.streams
        .filter((stream) => stream.kind === "subtitle")
        .map((stream) => stream.codec),
    ).toEqual(["subrip", "ass", "hdmv_pgs_subtitle"]);
  });

  test.each([
    [0, "Fixture"],
    [1, "<i>Fixture</i>"],
  ])("subtitle Stream %p converts to a WebVTT cue", async (index, text) => {
    const output = join(dir, `subs-${index}.vtt`);
    await convertToWebvtt(inputPath, index, output).done;
    const vtt = await Bun.file(output).text();
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00.000 --> 00:00.800");
    expect(vtt).toContain(text);
    expect(await Bun.file(`${output}.partial`).exists()).toBe(false);
  });

  test("a bitmap Stream fails to convert and leaves nothing behind", async () => {
    const output = join(dir, "subs-2.vtt");
    await expect(convertToWebvtt(inputPath, 2, output).done).rejects.toThrow(
      "WebVTT conversion failed",
    );
    expect(await Bun.file(output).exists()).toBe(false);
    expect(await Bun.file(`${output}.partial`).exists()).toBe(false);
  });

  test("a PGS Stream burns into the picture inside its box only", async () => {
    const probe = await probeVideo(inputPath);
    if (probe.durationSeconds === null || probe.keyframesSeconds === null) {
      throw new Error("Fixture probe returned no duration or keyframes.");
    }
    const directory = join(dir, "burn");
    await mkdir(directory);
    const indexes: number[] = [];
    const handle = startLiveRun(
      {
        inputPath,
        boundariesSeconds: deriveSegmentTimeline(
          probe.keyframesSeconds,
          probe.durationSeconds,
        ),
        startIndex: 0,
        directory,
        video: {
          action: "transcode",
          codec: "h264",
          profile: "high",
          level: null,
          maxFrameRate: null,
          width,
          height,
          bitrate: ladder[4].bitrate,
          rung: ladder[4],
          hdr: "sdr",
          toneMap: null,
          backend: "cpu",
          burnSubtitles: true,
        },
        burnSubtitle: 2,
      },
      (segments) => indexes.push(...segments.map((segment) => segment.index)),
    );
    expect(await handle.exited).toBe(0);
    expect(indexes[0]).toBe(0);
    const segment = join(directory, "0.m4s");
    expect(await fragmentOffset(segment)).toBeGreaterThan(0);

    // Luma of one frame at the given time, from the segment as written.
    const luma = async (seconds: number) => {
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          segment,
          "-ss",
          String(seconds),
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "gray",
          "-",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [bytes, code] = await Promise.all([
        new Response(proc.stdout).bytes(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(bytes.length).toBe(width * height);
      return (x: number, y: number) => bytes[y * width + x] ?? -1;
    };
    const box = pgsFixtureBox(width, height);
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const shown = await luma(0.4);
    expect(shown(centre.x, centre.y)).toBeGreaterThan(200);
    expect(shown(10, 10)).toBeLessThan(40);
    const cleared = await luma(1.2);
    expect(cleared(centre.x, centre.y)).toBeLessThan(40);
  }, 60_000);

  const hasLibx265 = Bun.spawnSync(["ffmpeg", "-hide_banner", "-encoders"])
    .stdout.toString()
    .includes("libx265");

  test.skipIf(!hasLibx265)(
    "a burned PGS Stream keeps an HDR picture 10-bit outside its box",
    async () => {
      const hdrPath = join(dir, "hdr-pgs.mkv");
      await createVideoFixture(hdrPath, {
        width,
        height,
        durationSeconds: 2,
        frameRate: 25,
        pattern: "testsrc2",
        videoCodec: "hevc",
        hdr: "hdr10",
        subtitles: ["pgs"],
      });
      // The run's own filter graph, read raw: an encoder's noise would mask
      // the levels an 8-bit blend throws away.
      const args = liveRunArguments({
        inputPath: hdrPath,
        boundariesSeconds: [0, 2],
        startIndex: 0,
        directory: dir,
        video: {
          action: "transcode",
          codec: "hevc",
          profile: "main10",
          level: null,
          maxFrameRate: null,
          width,
          height,
          bitrate: ladder[4].bitrate,
          rung: ladder[4],
          hdr: "hdr10",
          toneMap: null,
          backend: "cpu",
          burnSubtitles: true,
        },
        burnSubtitle: 0,
      });
      const graph = args[args.indexOf("-filter_complex") + 1];
      if (graph === undefined) throw new Error("Expected a filter graph.");
      // Frame 10 (0.4 s, the box showing) as raw 10-bit 4:2:0.
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          hdrPath,
          "-filter_complex",
          graph,
          "-map",
          "[v]",
          "-frames:v",
          "11",
          "-f",
          "rawvideo",
          "-",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [bytes, code] = await Promise.all([
        new Response(proc.stdout).bytes(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      const frameBytes = width * height * 3; // 1.5 samples per pixel, 2 bytes each
      expect(bytes.byteLength).toBe(frameBytes * 11);
      // The luma rows above the subtitle box.
      const samples = new Uint16Array(
        bytes.buffer,
        bytes.byteOffset + frameBytes * 10,
        width * pgsFixtureBox(width, height).y,
      );
      // An 8-bit blend keeps about 200 levels here; the 10-bit source has 800.
      expect(new Set(samples).size).toBeGreaterThan(400);
    },
    60_000,
  );
});
