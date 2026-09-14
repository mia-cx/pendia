import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { ffprobeKeyframeTimes } from "../mediums/video-common/keyframe-fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { deriveSegmentTimeline } from "../playback/timeline.ts";
import { parseSegmentList, remuxArguments, startRemuxRun } from "./remux.ts";

const probeFormat = async (path: string) => {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=start_time,duration",
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
  const parsed = JSON.parse(output) as {
    format?: { start_time?: string; duration?: string };
  };
  return {
    startTime: Number(parsed.format?.start_time),
    duration: Number(parsed.format?.duration),
  };
};

describe("remux", () => {
  let dir: string;
  let inputPath: string;
  let duration: number;
  let boundaries: number[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pendia-remux-"));
    inputPath = join(dir, "input.mkv");
    await createVideoFixture(inputPath, {
      width: 1920,
      height: 1080,
      durationSeconds: 12,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
    });
    const probe = await probeVideo(inputPath);
    if (probe.durationSeconds === null || probe.keyframesSeconds === null) {
      throw new Error("Fixture probe returned no duration or keyframes.");
    }
    duration = probe.durationSeconds;
    boundaries = deriveSegmentTimeline(probe.keyframesSeconds, duration);
    expect(boundaries.slice(0, 4)).toEqual([0, 3, 6, 9]);
    expect(boundaries.at(-1)).toBe(duration);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("remuxArguments", () => {
    test("a run from zero has no seek and interior cut times", () => {
      const args = remuxArguments({
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 0,
        directory: "/run",
      });
      expect(args).not.toContain("-ss");
      expect(args).not.toContain("-readrate");
      expect(args[args.indexOf("-segment_times") + 1]).toBe(
        "3000000us,6000000us,9000000us",
      );
      expect(args[args.indexOf("-segment_start_number") + 1]).toBe("0");
      expect(args[args.indexOf("-segment_header_filename") + 1]).toBe(
        "/run/init.mp4",
      );
      expect(args[args.indexOf("-segment_list") + 1]).toBe(
        "/run/segments.m3u8",
      );
      expect(args.at(-1)).toBe("/run/%d.m4s");
    });

    test("a restart seeks before the input and keeps every cut time", () => {
      const args = remuxArguments({
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 2,
        directory: "/run",
      });
      const seek = args.indexOf("-ss");
      expect(args[seek - 2]).toBe("-seek_timestamp");
      expect(args[seek - 1]).toBe("1");
      expect(args[seek + 1]).toBe("6000000us");
      expect(seek).toBeLessThan(args.indexOf("-i"));
      expect(args[args.indexOf("-segment_times") + 1]).toBe(
        "3000000us,6000000us,9000000us",
      );
      expect(args[args.indexOf("-segment_start_number") + 1]).toBe("2");
    });

    test("a Dolby Vision strip puts the bitstream filter right after -c copy", () => {
      const args = remuxArguments({
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 0,
        directory: "/run",
        stripDolbyVision: true,
      });
      const copy = args.indexOf("-c");
      expect(args[copy + 1]).toBe("copy");
      expect(args[copy + 2]).toBe("-bsf:v");
      expect(args[copy + 3]).toBe("dovi_rpu=strip=1");
      expect(args[copy + 4]).toBe("-copyts");
    });

    test("no Dolby Vision strip leaves the bitstream filter out", () => {
      const args = remuxArguments({
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 0,
        directory: "/run",
      });
      expect(args).not.toContain("-bsf:v");
    });

    test("a throttled run passes the read rate before the input", () => {
      const args = remuxArguments({
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 0,
        directory: "/run",
        readRate: { rate: 1, initialBurstSeconds: 3.5 },
      });
      const rate = args.indexOf("-readrate");
      expect(args[rate + 1]).toBe("1");
      expect(args[rate + 2]).toBe("-readrate_initial_burst");
      expect(args[rate + 3]).toBe("3.5");
      expect(rate).toBeLessThan(args.indexOf("-i"));
    });

    test("a one segment timeline omits cut times", () => {
      const args = remuxArguments({
        inputPath,
        boundariesSeconds: [0, 5],
        startIndex: 0,
        directory: "/run",
      });
      expect(args).not.toContain("-segment_times");
    });

    test.each([5, -1, 1.5])("rejects start index %p", (startIndex) => {
      expect(() =>
        remuxArguments({
          inputPath,
          boundariesSeconds: boundaries,
          startIndex,
          directory: "/run",
        }),
      ).toThrow(RangeError);
    });

    test("rejects a timeline with fewer than two boundaries", () => {
      expect(() =>
        remuxArguments({
          inputPath,
          boundariesSeconds: [0],
          startIndex: 0,
          directory: "/run",
        }),
      ).toThrow(RangeError);
    });
  });

  describe("parseSegmentList", () => {
    test("returns segment indexes in order and ignores other lines", () => {
      const text = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXTINF:3.000,",
        "2.m4s",
        "#EXTINF:3.000,",
        "3.m4s",
        "segments.m3u8.tmp",
        "init.mp4",
        "#EXT-X-ENDLIST",
      ].join("\n");
      expect(parseSegmentList(text)).toEqual([2, 3]);
    });
  });

  test("a full run cuts every segment at its boundary", async () => {
    const runDir = join(dir, "run-0");
    await mkdir(runDir);
    const batches: number[][] = [];
    const handle = startRemuxRun(
      {
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 0,
        directory: runDir,
      },
      (indexes) => batches.push(indexes),
    );
    expect(await handle.exited).toBe(0);
    const reported = batches.flat();
    expect(reported).toEqual([0, 1, 2, 3]);
    expect(await Bun.file(join(runDir, "init.mp4")).exists()).toBe(true);
    for (const index of [0, 1, 2, 3]) {
      const segmentPath = join(runDir, `${index}.m4s`);
      expect(await Bun.file(segmentPath).exists()).toBe(true);
      const joined = join(dir, `joined-${index}.mp4`);
      await Bun.write(
        joined,
        Buffer.concat([
          Buffer.from(await Bun.file(join(runDir, "init.mp4")).arrayBuffer()),
          Buffer.from(await Bun.file(segmentPath).arrayBuffer()),
        ]),
      );
      const format = await probeFormat(joined);
      expect(format.startTime).toBeCloseTo(boundaries[index] ?? 0, 1);
      const keyframes = await ffprobeKeyframeTimes(joined);
      expect(keyframes[0]).toBeCloseTo(boundaries[index] ?? 0, 3);
    }
  }, 30_000);

  test("a restart at segment two reports only new segments with absolute timestamps", async () => {
    const runDir = join(dir, "run-2");
    await mkdir(runDir);
    const batches: number[][] = [];
    const handle = startRemuxRun(
      {
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 2,
        directory: runDir,
      },
      (indexes) => batches.push(indexes),
    );
    expect(await handle.exited).toBe(0);
    expect(batches.flat()).toEqual([2, 3]);
    const first = Buffer.from(
      await Bun.file(join(dir, "run-0", "init.mp4")).arrayBuffer(),
    );
    const second = Buffer.from(
      await Bun.file(join(runDir, "init.mp4")).arrayBuffer(),
    );
    expect(second.equals(first)).toBe(true);
    const joined = join(dir, "joined-restart.mp4");
    await Bun.write(
      joined,
      Buffer.concat([
        second,
        Buffer.from(await Bun.file(join(runDir, "2.m4s")).arrayBuffer()),
      ]),
    );
    const format = await probeFormat(joined);
    expect(format.startTime).toBeCloseTo(6, 1);
    const keyframes = await ffprobeKeyframeTimes(joined);
    expect(keyframes[0]).toBeCloseTo(6, 3);
  }, 30_000);

  // The dovi_rpu bitstream filter arrived in ffmpeg 7.1; the runtime image has
  // it, the CI runner's apt ffmpeg 6.1 does not.
  const hasDoviFilter = Bun.spawnSync(["ffmpeg", "-hide_banner", "-bsfs"])
    .stdout.toString()
    .includes("dovi_rpu");
  const doviTest = test.skipIf(!hasDoviFilter);

  doviTest("a Dolby Vision strip runs on a hevc source", async () => {
    // The source carries no RPU, so the filter is a no-op; the run proves
    // ffmpeg accepts dovi_rpu=strip=1 in copy mode.
    const hevcPath = join(dir, "hevc.mkv");
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=25:d=8",
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
        "-x265-params",
        "log-level=error",
        "-g",
        "50",
        "-keyint_min",
        "50",
        "-sc_threshold",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "hvc1",
        hevcPath,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg failed (${code}): ${stderr.trim()}`);
    }
    const probe = await probeVideo(hevcPath);
    if (probe.durationSeconds === null || probe.keyframesSeconds === null) {
      throw new Error("HEVC probe returned no duration or keyframes.");
    }
    const hevcBoundaries = deriveSegmentTimeline(
      probe.keyframesSeconds,
      probe.durationSeconds,
    );
    const runDir = join(dir, "run-hevc");
    await mkdir(runDir);
    const batches: number[][] = [];
    const handle = startRemuxRun(
      {
        inputPath: hevcPath,
        boundariesSeconds: hevcBoundaries,
        startIndex: 0,
        directory: runDir,
        stripDolbyVision: true,
      },
      (indexes) => batches.push(indexes),
    );
    expect(await handle.exited).toBe(0);
    const segments = batches.flat();
    expect(segments.length).toBe(hevcBoundaries.length - 1);
    for (const index of segments) {
      expect(await Bun.file(join(runDir, `${index}.m4s`)).exists()).toBe(true);
    }
  });

  test("a throttled run reports the first segment and goes quiet after kill", async () => {
    const runDir = join(dir, "run-throttled");
    await mkdir(runDir);
    const batches: number[][] = [];
    const startedAt = Date.now();
    const handle = startRemuxRun(
      {
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 0,
        directory: runDir,
        readRate: { rate: 1, initialBurstSeconds: 3.5 },
      },
      (indexes) => batches.push(indexes),
    );
    while (batches.length === 0 && Date.now() - startedAt < 5000) {
      await Bun.sleep(20);
    }
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(batches[0]).toContain(0);
    await handle.kill();
    expect(await handle.exited).toBeNull();
    const count = batches.flat().length;
    await Bun.sleep(200);
    expect(batches.flat().length).toBe(count);
  }, 15_000);

  test("a missing input exits non-zero, reports nothing and logs once", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const runDir = join(dir, "run-bad");
      await mkdir(runDir);
      const batches: number[][] = [];
      const handle = startRemuxRun(
        {
          inputPath: join(dir, "missing.mkv"),
          boundariesSeconds: boundaries,
          startIndex: 0,
          directory: runDir,
        },
        (indexes) => batches.push(indexes),
      );
      const code = await handle.exited;
      expect(code).not.toBeNull();
      expect(code).not.toBe(0);
      expect(batches).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("remux.failed");
    } finally {
      spy.mockRestore();
    }
  }, 15_000);
});
