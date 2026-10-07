import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { ffprobeKeyframeTimes } from "../mediums/video-common/keyframe-fixtures.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { deriveSegmentTimeline } from "../playback/timeline.ts";
import {
  readStoreManifest,
  runStore,
  type StoreRun,
  storeArguments,
} from "./encode.ts";

const valueAfter = (args: readonly string[], flag: string) =>
  args[args.indexOf(flag) + 1];

const sdr = { codec: "h264", hdr: "sdr", audioCodec: "aac" };
const source = { name: "source" as const };
const p360 = { name: "360p", height: 360, bitrate: 1_000_000 };

describe("storeArguments", () => {
  const base = {
    inputPath: "/media/movie.mkv",
    boundariesSeconds: [0, 3, 6, 9.5],
    timelineId: "timeline",
    folder: "/media/movie.mkv.thalia/source",
  };

  test("the source rung copies video and fMP4-safe audio", () => {
    const args = storeArguments(
      { ...base, rung: source, source: sdr },
      0,
      "/p",
    );
    expect(valueAfter(args, "-c:v")).toBe("copy");
    expect(valueAfter(args, "-c:a")).toBe("copy");
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-tag:v");
  });

  test.each(["truehd", "eac3"])(
    "the source rung tags HEVC and encodes %s audio to AAC stereo",
    (audioCodec) => {
      const args = storeArguments(
        {
          ...base,
          rung: source,
          source: { codec: "hevc", hdr: "hdr10", audioCodec },
        },
        0,
        "/p",
      );
      expect(valueAfter(args, "-tag:v")).toBe("hvc1");
      expect(valueAfter(args, "-c:a")).toBe("aac");
      expect(valueAfter(args, "-ac")).toBe("2");
    },
  );

  test("an encoded rung scales, caps the bitrate and forces keyframes on the cuts", () => {
    const args = storeArguments({ ...base, rung: p360, source: sdr }, 0, "/p");
    expect(valueAfter(args, "-c:v")).toBe("libx264");
    expect(valueAfter(args, "-vf")).toBe("scale=-2:360,format=yuv420p");
    expect(valueAfter(args, "-maxrate")).toBe("1000000");
    expect(valueAfter(args, "-segment_times")).toBe("3000000us,6000000us");
    expect(valueAfter(args, "-force_key_frames")).toBe("3000000us,6000000us");
    expect(valueAfter(args, "-c:a")).toBe("aac");
  });

  test("a resumed encode forces only the cuts after its first segment", () => {
    const args = storeArguments({ ...base, rung: p360, source: sdr }, 1, "/p");
    expect(valueAfter(args, "-ss")).toBe("3000000us");
    expect(valueAfter(args, "-segment_start_number")).toBe("1");
    // Keyframes are forced at output pts; cuts count from the run's first pts.
    expect(valueAfter(args, "-force_key_frames")).toBe("6000000us");
    expect(valueAfter(args, "-segment_times")).toBe("3000000us");
  });

  test("an encoded rung tone maps an HDR source", () => {
    const args = storeArguments(
      { ...base, rung: p360, source: { ...sdr, hdr: "hdr10" } },
      0,
      "/p",
    );
    expect(valueAfter(args, "-vf")).toContain("tonemap=tonemap=hable");
    expect(valueAfter(args, "-vf")?.endsWith("format=yuv420p")).toBe(true);
  });
});

describe("runStore", () => {
  let dir: string;
  let inputPath: string;
  let boundaries: number[];
  const never = new AbortController().signal;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thalia-store-"));
    inputPath = join(dir, "movie.mkv");
    await createVideoFixture(inputPath, {
      width: 1280,
      height: 720,
      durationSeconds: 12,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
    });
    const probe = await probeVideo(inputPath);
    const { keyframesSeconds } = await readKeyframeIndex(inputPath);
    if (probe.durationSeconds === null || keyframesSeconds === null)
      throw new Error("Fixture probe returned no duration or keyframes.");
    boundaries = deriveSegmentTimeline(keyframesSeconds, probe.durationSeconds);
    expect(boundaries.slice(0, 4)).toEqual([0, 3, 6, 9]);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const runFor = (rung: StoreRun["rung"]): StoreRun => ({
    inputPath,
    boundariesSeconds: boundaries,
    timelineId: "timeline-1",
    rung,
    source: sdr,
    folder: join(dir, "movie.mkv.thalia", rung.name),
  });

  const joined = async (folder: string, indexes: number[], name: string) => {
    const parts = await Promise.all(
      ["init.mp4", ...indexes.map((index) => `${index}.m4s`)].map((part) =>
        readFile(join(folder, part)),
      ),
    );
    const path = join(dir, name);
    await Bun.write(path, Buffer.concat(parts));
    return path;
  };

  const expectOnTimeline = async (folder: string) => {
    const count = boundaries.length - 1;
    for (let index = 0; index < count; index++) {
      const path = await joined(folder, [index], `segment-${index}.mp4`);
      const keyframes = await ffprobeKeyframeTimes(path);
      expect(keyframes[0]).toBeCloseTo(boundaries[index] ?? -1, 3);
      // A 3 s segment is shorter than x264's keyframe interval: one keyframe each.
      expect(keyframes).toHaveLength(1);
    }
    const all = await joined(
      folder,
      Array.from({ length: count }, (_, index) => index),
      "all.mp4",
    );
    const decode = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-i",
      all,
      "-f",
      "null",
      "-",
    ]);
    expect(decode.exitCode).toBe(0);
    expect(decode.stderr.toString()).toBe("");
  };

  test("both rungs cut every segment on the timeline and write the manifest last", async () => {
    for (const rung of [source, p360]) {
      const run = runFor(rung);
      expect(await runStore(run, never)).toBe("complete");
      expect((await readdir(run.folder)).sort()).toEqual(
        [
          "0.m4s",
          "1.m4s",
          "2.m4s",
          "3.m4s",
          "init.mp4",
          "manifest.json",
          "rung.json",
        ].sort(),
      );
      expect(await readStoreManifest(run.folder)).toEqual({
        timelineId: "timeline-1",
        rung: rung.name,
        segments: ["0.m4s", "1.m4s", "2.m4s", "3.m4s"],
        complete: true,
      });
      await expectOnTimeline(run.folder);
    }
    const encoded = await probeVideo(
      await joined(runFor(p360).folder, [0], "probe.mp4"),
    );
    expect(encoded.streams.find((s) => s.kind === "video")).toMatchObject({
      codec: "h264",
      profile: "high",
      width: 640,
      height: 360,
    });
  }, 120_000);

  test("a complete folder is left alone", async () => {
    const run = runFor(source);
    const before = await stat(join(run.folder, "manifest.json"));
    expect(await runStore(run, never)).toBe("complete");
    const after = await stat(join(run.folder, "manifest.json"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("an edited rung under the same name starts its folder over", async () => {
    const run = runFor(p360);
    const edited = { ...run, rung: { ...p360, height: 240 } };
    expect(await runStore(edited, never)).toBe("complete");
    const encoded = await probeVideo(
      await joined(run.folder, [0], "edited.mp4"),
    );
    expect(encoded.streams.find((s) => s.kind === "video")?.height).toBe(240);
    expect(
      JSON.parse(await readFile(join(run.folder, "rung.json"), "utf8")),
    ).toEqual(edited.rung);
  }, 60_000);

  test.skipIf(process.platform !== "linux")(
    "a stopped run resumes at the first missing segment without rewriting present ones",
    async () => {
      const run = { ...runFor({ ...p360, name: "resume" }) };
      const controller = new AbortController();
      const stopped = runStore(
        { ...run, readRate: { rate: 2, initialBurstSeconds: 0 } },
        controller.signal,
      );
      const first = join(run.folder, "0.m4s");
      const deadline = Date.now() + 20_000;
      while (!(await Bun.file(first).exists())) {
        if (Date.now() > deadline) throw new Error("Segment 0 never landed.");
        await Bun.sleep(25);
      }
      expect(await Bun.file(join(run.folder, "manifest.json")).exists()).toBe(
        false,
      );
      // ffmpeg runs at the lowest CPU priority.
      expect(await niceOf(join(run.folder, ".partial"))).toBe(19);
      controller.abort();
      expect(await stopped).toBe("stopped");
      const present = (await readdir(run.folder)).filter((name) =>
        name.endsWith(".m4s"),
      );
      expect(present.length).toBeLessThan(4);
      const kept = await Promise.all(
        present.map(async (name) => {
          const info = await stat(join(run.folder, name));
          return { name, ino: info.ino, mtimeMs: info.mtimeMs };
        }),
      );
      const init = await readFile(join(run.folder, "init.mp4"));

      expect(await runStore(run, never)).toBe("complete");
      for (const segment of kept) {
        const info = await stat(join(run.folder, segment.name));
        expect({
          name: segment.name,
          ino: info.ino,
          mtimeMs: info.mtimeMs,
        }).toEqual(segment);
      }
      expect((await readFile(join(run.folder, "init.mp4"))).equals(init)).toBe(
        true,
      );
      expect(await Bun.file(join(run.folder, ".partial")).exists()).toBe(false);
      await expectOnTimeline(run.folder);
    },
    60_000,
  );
});

/** Finds the process whose command line names the directory and reads its nice value. */
async function niceOf(directory: string) {
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
      () => "",
    );
    if (!cmdline.includes(directory) || !cmdline.startsWith("ffmpeg")) continue;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Field 19 of stat is the nice value; the slice starts at field 3.
    return Number(fields[16]);
  }
  return null;
}

describe("runStore on a nonuniform timeline", () => {
  let dir: string;
  let boundaries: number[];
  const never = new AbortController().signal;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thalia-store-uneven-"));
    // Segments of 5, 3, 4 and 4 s; the keyframe at 14 s sits inside the
    // last one, where a stray cut would split it.
    const encode = Bun.spawnSync([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=25:d=16",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "16",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-force_key_frames",
      "0,5,8,12,14",
      "-g",
      "1000",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      join(dir, "uneven.mkv"),
    ]);
    if (encode.exitCode !== 0) throw new Error(encode.stderr.toString());
    const probe = await probeVideo(join(dir, "uneven.mkv"));
    const { keyframesSeconds } = await readKeyframeIndex(
      join(dir, "uneven.mkv"),
    );
    if (probe.durationSeconds === null || keyframesSeconds === null)
      throw new Error("Fixture probe returned no duration or keyframes.");
    boundaries = [0, 5, 8, 12, probe.durationSeconds];
    expect(keyframesSeconds).toEqual([0, 5, 8, 12, 14]);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Returns the first and last video pts of each segment, decoded with the init. */
  const intervals = async (folder: string) => {
    const init = await readFile(join(folder, "init.mp4"));
    const result: [number, number][] = [];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const path = join(dir, "probe.mp4");
      await Bun.write(
        path,
        Buffer.concat([init, await readFile(join(folder, `${index}.m4s`))]),
      );
      const probe = Bun.spawnSync([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        path,
      ]);
      const times = probe.stdout
        .toString()
        .trim()
        .split("\n")
        .map(Number)
        .sort((a, b) => a - b);
      result.push([times[0] ?? -1, times.at(-1) ?? -1]);
    }
    return result;
  };

  const expectIntervals = async (folder: string) => {
    const measured = await intervals(folder);
    measured.forEach(([first, last], index) => {
      expect(first).toBeCloseTo(boundaries[index] ?? -1, 3);
      // The last frame starts within one 40 ms frame of the next boundary.
      expect(last).toBeLessThan(boundaries[index + 1] ?? 0);
      expect(last).toBeGreaterThan((boundaries[index + 1] ?? 0) - 0.1);
    });
  };

  test.each([
    ["the source rung", source],
    ["an encoded rung", p360],
  ])(
    "%s resumes from segment 1 and from the last segment on the timeline",
    async (_name, rung) => {
      const run: StoreRun = {
        inputPath: join(dir, "uneven.mkv"),
        boundariesSeconds: boundaries,
        timelineId: "uneven",
        rung,
        source: sdr,
        folder: join(dir, "uneven.mkv.thalia", rung.name),
      };
      expect(await runStore(run, never)).toBe("complete");
      await expectIntervals(run.folder);
      for (const kept of [1, 3]) {
        await rm(join(run.folder, "manifest.json"));
        for (let index = kept; index < boundaries.length - 1; index++)
          await rm(join(run.folder, `${index}.m4s`));
        expect(await runStore(run, never)).toBe("complete");
        await expectIntervals(run.folder);
      }
    },
    60_000,
  );
});
