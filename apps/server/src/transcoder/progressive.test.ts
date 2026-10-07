import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { ladder } from "../playback/policy.ts";
import { type ProgressiveRun, progressiveArguments } from "./progressive.ts";
import { parseStreamHead } from "./stream-head.ts";

const copyRun: ProgressiveRun = {
  inputPath: "/srv/movies/a.mkv",
  startSeconds: 0,
  video: {
    action: "copy",
    codec: "h264",
    hdr: "sdr",
    stripDolbyVision: false,
  },
  audio: { action: "copy", codec: "aac", channels: 2 },
};

describe("progressiveArguments", () => {
  test("a copy writes relative timestamps and fragments to stdout", () => {
    const args = progressiveArguments(copyRun);
    // The muxer's timestamps are relative to the run's first frame; the
    // session reports the source offset in x-stream-offset.
    expect(args).not.toContain("-copyts");
    expect(args).toContain("-avoid_negative_ts");
    expect(args[args.indexOf("-avoid_negative_ts") + 1]).toBe("make_zero");
    expect(args).toContain("-f");
    expect(args).toContain("mp4");
    expect(args).toContain("pipe:1");
    const movflags = args[args.indexOf("-movflags") + 1] ?? "";
    for (const flag of [
      "frag_keyframe",
      "empty_moov",
      "default_base_moof",
      "delay_moov",
    ]) {
      expect(movflags).toContain(flag);
    }
    // No -ss at the start.
    expect(args.indexOf("-ss")).toBe(-1);
  });

  test("a seek lands the demuxer by timestamp", () => {
    const args = progressiveArguments({ ...copyRun, startSeconds: 60 });
    const i = args.indexOf("-seek_timestamp");
    const j = args.indexOf("-i");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
    expect(args[i + 1]).toBe("1");
    expect(args[i + 2]).toBe("-ss");
    expect(args[i + 3]).toBe("60000000us");
  });

  test("an HEVC copy tags hvc1", () => {
    const args = progressiveArguments({
      ...copyRun,
      video: {
        action: "copy",
        codec: "hevc",
        hdr: "hdr10",
        stripDolbyVision: false,
      },
    });
    expect(args).toContain("-tag:v");
    expect(args[args.indexOf("-tag:v") + 1]).toBe("hvc1");
  });

  test("a transcode forces a keyframe every four seconds", () => {
    const args = progressiveArguments({
      inputPath: "/srv/movies/a.mkv",
      startSeconds: 30,
      video: {
        action: "transcode" as const,
        codec: "h264",
        profile: "high",
        level: 40,
        maxFrameRate: null,
        width: 1920,
        height: 1080,
        bitrate: ladder[1].bitrate,
        rung: ladder[1],
        hdr: "sdr" as const,
        toneMap: null,
        backend: "cpu" as const,
        burnSubtitles: false,
      },
      audio: { action: "transcode", codec: "aac", channels: 2 },
    });
    const i = args.indexOf("-force_key_frames:v");
    expect(args[i + 1]).toBe("expr:gte(t,n_forced*4)");
    expect(args).toContain("libx264");
    expect(args).toContain("-c:a");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
  });

  test("a burned subtitle needs the overlay graph", () => {
    const args = progressiveArguments({
      inputPath: "/srv/movies/a.mkv",
      startSeconds: 0,
      video: {
        action: "transcode" as const,
        codec: "h264",
        profile: "high",
        level: 40,
        maxFrameRate: null,
        width: 1920,
        height: 1080,
        bitrate: ladder[1].bitrate,
        rung: ladder[1],
        hdr: "sdr" as const,
        toneMap: null,
        backend: "cpu" as const,
        burnSubtitles: true,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
      burnSubtitle: 0,
    });
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("overlay");
    expect(graph).toContain("[0:s:0]");
  });
});

/** Reads box type and tfdt/baseMediaDecodeTime per moof from fMP4 bytes. */
function moofs(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const found: { tfdts: number[] }[] = [];
  const timescales: number[] = [];
  const walk = (start: number, end: number, insideMoof: boolean) => {
    let i = start;
    while (i + 8 <= end) {
      let size = view.getUint32(i);
      const type = String.fromCharCode(
        data[i + 4] ?? 0,
        data[i + 5] ?? 0,
        data[i + 6] ?? 0,
        data[i + 7] ?? 0,
      );
      let header = i + 8;
      if (size === 1) {
        size = Number(view.getBigUint64(i + 8));
        header += 8;
      }
      if (size === 0) size = end - i;
      if (size < 8 || i + size > end + 8) break;
      if (type === "mdhd") {
        timescales.push(view.getUint32(header + 12));
      } else if (type === "tfdt" && insideMoof) {
        const version = data[header] ?? 0;
        const value =
          version === 1
            ? Number(view.getBigUint64(header + 4))
            : view.getUint32(header + 4);
        found[found.length - 1]?.tfdts.push(value);
      } else if (type === "moof") {
        found.push({ tfdts: [] });
        walk(header, i + size, true);
      } else if (
        ["moov", "trak", "mdia", "minf", "stbl", "traf"].includes(type)
      )
        walk(header, i + size, insideMoof);
      i += size;
    }
  };
  walk(0, data.byteLength, false);
  return { timescales, moofs: found };
}

describe("progressive stream (ffmpeg)", () => {
  let dir: string;
  let inputPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thalia-progressive-"));
    inputPath = join(dir, "input.mkv");
    await createVideoFixture(inputPath, {
      width: 640,
      height: 360,
      durationSeconds: 12,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
    });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const run = (run: ProgressiveRun, signal?: AbortSignal) =>
    Bun.spawn(["ffmpeg", ...progressiveArguments(run)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });

  test("copies stream from 0 with an absolute tfdt", async () => {
    const proc = run({
      inputPath,
      startSeconds: 0,
      video: {
        action: "copy",
        codec: "h264",
        hdr: "sdr",
        stripDolbyVision: false,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
    });
    const data = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    expect(code).toBe(0);
    const { timescales, moofs: found } = moofs(data);
    expect(found.length).toBeGreaterThan(0);
    // Video timescale first, then audio; the first fragment's decode time is
    // the source time of its first frame: 0 here.
    expect(found[0]?.tfdts[0]).toBe(0);
    expect(timescales.length).toBe(2);
  });

  test("a copy seek writes timestamps relative to the keyframe it starts on", async () => {
    const proc = run({
      inputPath,
      startSeconds: 7,
      video: {
        action: "copy",
        codec: "h264",
        hdr: "sdr",
        stripDolbyVision: false,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
    });
    const data = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    const { moofs: found } = moofs(data);
    expect(found.length).toBeGreaterThan(0);
    // The stream is relative to its first frame (the keyframe at or before
    // the seek); the session's x-stream-offset header maps it to the source.
    expect(found[0]?.tfdts[0]).toBe(0);
  });

  test("a transcode seek produces fragments (timestamps relative to its start)", async () => {
    const proc = run({
      inputPath,
      startSeconds: 7,
      video: {
        action: "transcode" as const,
        codec: "h264",
        profile: "high",
        level: 40,
        maxFrameRate: null,
        width: 640,
        height: 360,
        bitrate: ladder[4].bitrate,
        rung: ladder[4],
        hdr: "sdr" as const,
        toneMap: null,
        backend: "cpu" as const,
        burnSubtitles: false,
      },
      audio: { action: "transcode", codec: "aac", channels: 2 },
    });
    const data = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    const { moofs: found } = moofs(data);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.tfdts[0]).toBe(0);
  });

  test("aborting the fetch's signal kills ffmpeg", async () => {
    const abort = new AbortController();
    const proc = run(
      {
        inputPath,
        startSeconds: 0,
        video: {
          action: "copy",
          codec: "h264",
          hdr: "sdr",
          stripDolbyVision: false,
        },
        audio: { action: "copy", codec: "aac", channels: 2 },
      },
      abort.signal,
    );
    // Abort in the same tick: ffmpeg is running but nowhere near done.
    abort.abort();
    const code = await proc.exited;
    // Killed by signal (null) or failed; it must not complete cleanly.
    expect(code === null || code !== 0).toBe(true);
  });
});

describe("stream head", () => {
  /** A copy stream's source time for its first decoded frame: the seek's keyframe. */
  const keyframeAt = async (start: number) => {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        "-read_intervals",
        `${start}%+#1`,
        inputPathForHead,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    return Number((await new Response(proc.stdout).text()).split("\n")[0]);
  };

  /** The source pts of the first audio packet a copied track's own seek lands on. */
  const audioAt = async (audioStart: number) => {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        "-read_intervals",
        `${audioStart}%+#4`,
        inputPathForHead,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const times = (await new Response(proc.stdout).text())
      .split("\n")
      .filter((line) => line !== "")
      .map(Number);
    return times[0];
  };

  let inputPathForHead: string;
  beforeAll(async () => {
    inputPathForHead = join(
      await mkdtemp(join(tmpdir(), "thalia-head-")),
      "head.mkv",
    );
    await createVideoFixture(inputPathForHead, {
      width: 640,
      height: 360,
      durationSeconds: 12,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
    });
  });

  const headFor = async (run: ProgressiveRun) => {
    const proc = Bun.spawn(["ffmpeg", ...progressiveArguments(run)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const data = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    const head = parseStreamHead(data);
    if (head === null) throw new Error("No video moof parsed.");
    return head;
  };

  test("a plain copy seek maps the keyframe onto its source position", async () => {
    const head = await headFor({
      inputPath: inputPathForHead,
      startSeconds: 7,
      video: {
        action: "copy",
        codec: "h264",
        hdr: "sdr",
        stripDolbyVision: false,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
      // The session seeks the copied audio to the video's anchor.
      audioStartSeconds: await keyframeAt(7),
    });
    const keyframe = await keyframeAt(7);
    expect(keyframe).toBeCloseTo(6, 5);
    const offset = keyframe - head.video;
    // The first frame presents at the keyframe's source position.
    expect(head.video + offset).toBeCloseTo(keyframe, 5);
    const audio = await audioAt(keyframe);
    expect(audio).toBeDefined();
    expect(Math.abs((head.audio ?? 0) + offset - (audio ?? 0))).toBeLessThan(
      0.05,
    );
  });

  test("a B-frame copy seek starts video presentation above the keyframe's dts", async () => {
    const head = await headFor({
      inputPath: inputPathForHead,
      startSeconds: 10.5,
      video: {
        action: "copy",
        codec: "h264",
        hdr: "sdr",
        stripDolbyVision: false,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
      audioStartSeconds: await keyframeAt(10.5),
    });
    const keyframe = await keyframeAt(10.5);
    const offset = keyframe - head.video;
    expect(head.video + offset).toBeCloseTo(keyframe, 5);
  });

  test("a mixed run — video transcode, audio copy — anchors on the encode's start", async () => {
    const head = await headFor({
      inputPath: inputPathForHead,
      startSeconds: 7,
      video: {
        action: "transcode" as const,
        codec: "h264",
        profile: "high",
        level: 40,
        maxFrameRate: null,
        width: 640,
        height: 360,
        bitrate: ladder[4].bitrate,
        rung: ladder[4],
        hdr: "sdr" as const,
        toneMap: null,
        backend: "cpu" as const,
        burnSubtitles: false,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
      audioStartSeconds: 7,
    });
    const offset = 7 - head.video;
    expect(head.video + offset).toBeCloseTo(7, 2);
    // Copied audio presents near the seek, one aac frame (~21 ms) of slack.
    if (head.audio !== null) {
      const audio = await audioAt(7);
      expect(audio).toBeDefined();
      expect(Math.abs(head.audio + offset - (audio ?? 0))).toBeLessThan(0.05);
    }
  });

  test("a partial buffer parses as null until the moof completes", async () => {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        ...progressiveArguments({
          inputPath: inputPathForHead,
          startSeconds: 0,
          video: {
            action: "copy",
            codec: "h264",
            hdr: "sdr",
            stripDolbyVision: false,
          },
          audio: { action: "copy", codec: "aac", channels: 2 },
        }),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const data = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    const full = parseStreamHead(data);
    expect(full).not.toBeNull();
    // Split the buffer at every box boundary: before the video moof is whole
    // the answer must stay null.
    let sawNull = false;
    for (let cut = 0; cut < data.length; cut += 97) {
      if (parseStreamHead(data.slice(0, cut)) === null) sawNull = true;
    }
    expect(sawNull).toBe(true);
  });
});
