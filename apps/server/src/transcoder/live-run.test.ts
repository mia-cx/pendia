import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { ffprobeKeyframeTimes } from "../mediums/video-common/keyframe-fixtures.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { ladder } from "../playback/policy.ts";
import { deriveSegmentTimeline } from "../playback/timeline.ts";
import {
  fragmentOffset,
  type LiveRun,
  liveRunArguments,
  parseSegmentList,
  type ReadySegment,
  startLiveRun,
  type VideoDecision,
} from "./live-run.ts";
import { runStartupTrial } from "./trial.ts";

type TranscodeDecision = Extract<VideoDecision, { action: "transcode" }>;

const copy = (codec = "h264", stripDolbyVision = false): VideoDecision => ({
  action: "copy",
  codec,
  hdr: "sdr",
  stripDolbyVision,
});

const transcode = (
  overrides: Partial<TranscodeDecision> = {},
): TranscodeDecision => ({
  action: "transcode",
  codec: "h264",
  profile: "high",
  level: 41,
  maxFrameRate: 30,
  width: 1280,
  height: 720,
  bitrate: 3_000_000,
  rung: ladder[3],
  hdr: "sdr",
  toneMap: null,
  backend: "cpu",
  burnSubtitles: false,
  ...overrides,
});

const runProcess = async (command: string[]) => {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
  }
  return output;
};

const probeFormat = async (path: string) => {
  const output = await runProcess([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=start_time,duration",
    "-of",
    "json",
    "-i",
    path,
  ]);
  const parsed = JSON.parse(output) as {
    format?: { start_time?: string; duration?: string };
  };
  return {
    startTime: Number(parsed.format?.start_time),
    duration: Number(parsed.format?.duration),
  };
};

type ProbedStream = {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_transfer?: string;
  channels?: number;
};

const probeStreams = async (path: string) => {
  const output = await runProcess([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,color_transfer,channels",
    "-of",
    "json",
    "-i",
    path,
  ]);
  return (JSON.parse(output) as { streams: ProbedStream[] }).streams;
};

const firstVideoPts = async (path: string) => {
  const output = await runProcess([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v",
    "-show_entries",
    "packet=pts_time,dts_time",
    "-read_intervals",
    "%+#1",
    "-of",
    "csv=p=0",
    "-i",
    path,
  ]);
  const [pts, dts] = output.trim().split(",").map(Number);
  return { pts, dts };
};

/** Lists every video packet's timestamps and payload hash, so two runs can be compared packet for packet. */
const videoPacketHashes = async (path: string) =>
  (
    await runProcess([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "packet=pts,dts,data_hash",
      "-show_data_hash",
      "md5",
      "-of",
      "csv=p=0",
      "-i",
      path,
    ])
  )
    .split("\n")
    .filter((line) => line !== "");

const encoders = Bun.spawnSync(["ffmpeg", "-hide_banner", "-encoders"])
  .stdout.toString()
  .split("\n");
const hasEncoder = (name: string) =>
  encoders.some((line) => line.split(/\s+/)[2] === name);
const hasLibx265 = hasEncoder("libx265");
const hasZscale = Bun.spawnSync(["ffmpeg", "-hide_banner", "-filters"])
  .stdout.toString()
  .includes(" zscale ");

describe("liveRunArguments", () => {
  const boundaries = [0, 3, 6, 9, 12];
  const base = (overrides: Partial<LiveRun> = {}): LiveRun => ({
    inputPath: "/media/input.mkv",
    boundariesSeconds: boundaries,
    startIndex: 0,
    directory: "/run",
    video: copy(),
    ...overrides,
  });
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  describe("segmenting", () => {
    test("a run from zero has no seek and interior cut times", () => {
      const args = liveRunArguments(base());
      expect(args).not.toContain("-ss");
      expect(args).not.toContain("-readrate");
      expect(after(args, "-segment_times")).toBe(
        "3000000us,6000000us,9000000us",
      );
      expect(after(args, "-segment_start_number")).toBe("0");
      expect(after(args, "-individual_header_trailer")).toBe("1");
      expect(after(args, "-segment_format_options")).toContain(
        "+delay_moov+skip_trailer",
      );
      expect(args).not.toContain("-segment_header_filename");
      expect(after(args, "-segment_list")).toBe("/run/segments.m3u8");
      expect(args.at(-1)).toBe("/run/%d.m4s");
    });

    test("a restart seeks before the input and cuts relative to its start", () => {
      const args = liveRunArguments(
        base({ startIndex: 1, boundariesSeconds: [0, 5, 8, 12, 16] }),
      );
      const seek = args.indexOf("-ss");
      expect(args[seek - 2]).toBe("-seek_timestamp");
      expect(args[seek - 1]).toBe("1");
      expect(args[seek + 1]).toBe("5000000us");
      expect(seek).toBeLessThan(args.indexOf("-i"));
      expect(after(args, "-segment_times")).toBe("3000000us,7000000us");
      expect(after(args, "-segment_start_number")).toBe("1");
    });

    test("a run in the last segment keeps it whole instead of listing cuts", () => {
      for (const args of [
        liveRunArguments(base({ startIndex: 3 })),
        liveRunArguments(base({ boundariesSeconds: [0, 5] })),
      ]) {
        expect(args).not.toContain("-segment_times");
        expect(after(args, "-segment_time")).toBe("86400");
      }
    });

    test("a throttled run passes the read rate before the input", () => {
      const args = liveRunArguments(
        base({ readRate: { rate: 1, initialBurstSeconds: 3.5 } }),
      );
      const rate = args.indexOf("-readrate");
      expect(args[rate + 1]).toBe("1");
      expect(args[rate + 2]).toBe("-readrate_initial_burst");
      expect(args[rate + 3]).toBe("3.5");
      expect(rate).toBeLessThan(args.indexOf("-i"));
    });

    test.each([4, -1, 1.5])("rejects start index %p", (startIndex) => {
      expect(() => liveRunArguments(base({ startIndex }))).toThrow(RangeError);
    });

    test("rejects a timeline with fewer than two boundaries", () => {
      expect(() => liveRunArguments(base({ boundariesSeconds: [0] }))).toThrow(
        RangeError,
      );
    });
  });

  describe("video copy", () => {
    test("copies the main video Stream and nothing else from the video", () => {
      const args = liveRunArguments(base());
      expect(after(args, "-map")).toBe("0:V:0");
      expect(after(args, "-c:v")).toBe("copy");
      expect(args).not.toContain("-filter_complex");
      expect(args).not.toContain("-force_key_frames:v");
      expect(args).not.toContain("-tag:v");
      expect(args).not.toContain("-bsf:v");
    });

    test("a hevc copy tags hvc1 and a Dolby Vision strip follows it", () => {
      const args = liveRunArguments(base({ video: copy("hevc", true) }));
      const codec = args.indexOf("-c:v");
      expect(args.slice(codec, codec + 6)).toEqual([
        "-c:v",
        "copy",
        "-tag:v",
        "hvc1",
        "-bsf:v",
        "dovi_rpu=strip=1",
      ]);
    });

    test("refuses to burn a subtitle into copied video", () => {
      expect(() => liveRunArguments(base({ burnSubtitle: 0 }))).toThrow(
        RangeError,
      );
    });
  });

  describe("video transcode", () => {
    test("scales to the rung and encodes H.264 on the CPU with only forced keyframes", () => {
      const args = liveRunArguments(base({ video: transcode() }));
      expect(after(args, "-filter_complex")).toBe(
        "[0:V:0]scale=w=1280:h=720,format=yuv420p[v]",
      );
      expect(after(args, "-map")).toBe("[v]");
      const codec = args.indexOf("-c:v");
      expect(args.slice(codec, codec + 8)).toEqual([
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-bf",
        "0",
        "-x264-params",
        "scenecut=0:keyint=infinite",
      ]);
      expect(after(args, "-profile:v")).toBe("high");
      expect(after(args, "-level:v")).toBe("4.1");
      expect(after(args, "-b:v")).toBe("3000000");
      expect(after(args, "-maxrate")).toBe("3000000");
      expect(after(args, "-bufsize")).toBe("6000000");
      expect(after(args, "-fpsmax")).toBe("30");
    });

    test("lets the muxer take each forced keyframe within half the shortest segment", () => {
      const boundariesSeconds = [0, 4.04, 8, 13, 16];
      expect(
        after(
          liveRunArguments(base({ video: transcode(), boundariesSeconds })),
          "-segment_time_delta",
        ),
      ).toBe("1980000us");
      expect(
        after(
          liveRunArguments(
            base({ video: transcode(), boundariesSeconds, startIndex: 2 }),
          ),
          "-segment_time_delta",
        ),
      ).toBe("2500000us");
      // A copy cuts on source keyframes, which may sit anywhere.
      expect(liveRunArguments(base({ boundariesSeconds }))).not.toContain(
        "-segment_time_delta",
      );
    });

    test("forces keyframes on the timeline boundaries the run reaches", () => {
      expect(
        after(
          liveRunArguments(base({ video: transcode() })),
          "-force_key_frames:v",
        ),
      ).toBe("3.000000,6.000000,9.000000");
      expect(
        after(
          liveRunArguments(base({ video: transcode(), startIndex: 2 })),
          "-force_key_frames:v",
        ),
      ).toBe("9.000000");
      expect(
        liveRunArguments(base({ video: transcode(), startIndex: 3 })),
      ).not.toContain("-force_key_frames:v");
    });

    test("floors forced times to the microsecond like the cut times", () => {
      const args = liveRunArguments(
        base({
          video: transcode(),
          boundariesSeconds: [0, 4.0041666666, 8.0083333333, 10],
        }),
      );
      expect(after(args, "-force_key_frames:v")).toBe("4.004166,8.008333");
      expect(after(args, "-segment_times")).toBe("4004166us,8008333us");
    });

    test("leaves out the level and frame rate cap the engine did not set", () => {
      const args = liveRunArguments(
        base({ video: transcode({ level: null, maxFrameRate: null }) }),
      );
      expect(args).not.toContain("-level:v");
      expect(args).not.toContain("-fpsmax");
    });

    test.each([
      ["hdr10", "smpte2084"],
      ["hdr10+", "smpte2084"],
      ["dolby-vision", "smpte2084"],
      ["hlg", "arib-std-b67"],
    ] as const)(
      "tone maps %s from %s to BT.709 after scaling",
      (hdr, transfer) => {
        const graph = after(
          liveRunArguments(base({ video: transcode({ toneMap: hdr }) })),
          "-filter_complex",
        );
        expect(graph).toBe(
          "[0:V:0]scale=w=1280:h=720," +
            `zscale=tin=${transfer}:pin=bt2020:min=bt2020nc:rin=tv:t=linear:p=bt2020:npl=100,` +
            "format=gbrpf32le,zscale=tin=linear:pin=bt2020:p=bt709," +
            "tonemap=tonemap=hable:desat=0," +
            "zscale=tin=linear:pin=bt709:t=bt709:m=bt709:r=tv,format=yuv420p[v]",
        );
      },
    );

    test("burns a bitmap subtitle over the scaled picture", () => {
      const args = liveRunArguments(
        base({ video: transcode({ burnSubtitles: true }), burnSubtitle: 1 }),
      );
      expect(after(args, "-filter_complex")).toBe(
        "[0:V:0]scale=w=1280:h=720[base];" +
          "[0:s:1]scale=w=1280:h=720[subtitle];" +
          "[base][subtitle]overlay=eof_action=pass:repeatlast=0,format=yuv420p[v]",
      );
      expect(args).toContain("-sn");
    });

    test("blends a burned subtitle in 10-bit when the output keeps HDR", () => {
      const args = liveRunArguments(
        base({
          video: transcode({
            codec: "hevc",
            profile: "main10",
            hdr: "hdr10",
            burnSubtitles: true,
          }),
          burnSubtitle: 0,
        }),
      );
      expect(after(args, "-filter_complex")).toContain(
        "overlay=eof_action=pass:repeatlast=0:format=yuv420p10,format=yuv420p10le[v]",
      );
    });

    test("keeps HDR in 10-bit HEVC tagged hvc1", () => {
      const args = liveRunArguments(
        base({
          video: transcode({
            codec: "hevc",
            profile: "main10",
            level: 150,
            hdr: "hdr10",
          }),
        }),
      );
      expect(after(args, "-filter_complex")).toBe(
        "[0:V:0]scale=w=1280:h=720,format=yuv420p10le[v]",
      );
      const codec = args.indexOf("-c:v");
      expect(args.slice(codec, codec + 10)).toEqual([
        "-c:v",
        "libx265",
        "-preset",
        "superfast",
        "-x265-params",
        "bframes=0:scenecut=0:keyint=-1:log-level=error",
        "-forced-idr",
        "1",
        "-tag:v",
        "hvc1",
      ]);
      expect(after(args, "-profile:v")).toBe("main10");
      expect(args).not.toContain("-level:v");
    });

    test("encodes AV1 with SVT-AV1 at a target bitrate and lets it pick the profile", () => {
      const args = liveRunArguments(
        base({ video: transcode({ codec: "av1", profile: "main", level: 8 }) }),
      );
      const codec = args.indexOf("-c:v");
      expect(args.slice(codec, codec + 6)).toEqual([
        "-c:v",
        "libsvtav1",
        "-preset",
        "10",
        "-svtav1-params",
        "keyint=2147483647:scd=0",
      ]);
      expect(after(args, "-b:v")).toBe("3000000");
      // SVT-AV1 refuses a bitrate ceiling outside CRF mode.
      expect(args).not.toContain("-maxrate");
      expect(args).not.toContain("-profile:v");
      expect(args).not.toContain("-level:v");
    });

    test("rejects a codec without a live encoder", () => {
      expect(() =>
        liveRunArguments(base({ video: transcode({ codec: "vp9" }) })),
      ).toThrow(RangeError);
    });
  });

  describe("audio", () => {
    test("copies the first audio Stream when there is one", () => {
      for (const audio of [
        undefined,
        { action: "copy", codec: "aac", channels: 2 } as const,
      ]) {
        const args = liveRunArguments(base({ audio }));
        const map = args.lastIndexOf("-map");
        expect(args.slice(map, map + 4)).toEqual([
          "-map",
          "0:a:0?",
          "-c:a",
          "copy",
        ]);
      }
    });

    test("downmixes to AAC stereo", () => {
      const args = liveRunArguments(
        base({ audio: { action: "transcode", codec: "aac", channels: 2 } }),
      );
      const map = args.lastIndexOf("-map");
      expect(args.slice(map, map + 8)).toEqual([
        "-map",
        "0:a:0",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-b:a",
        "192000",
      ]);
    });

    test("maps the selected audio Stream for a copy and a re-encode", () => {
      for (const audio of [
        undefined,
        { action: "transcode", codec: "aac", channels: 2 } as const,
      ]) {
        const args = liveRunArguments(base({ audio, audioStream: 1 }));
        const map = args.lastIndexOf("-map");
        expect(args.slice(map, map + 3)).toEqual(["-map", "0:a:1", "-c:a"]);
      }
    });

    test("encodes EAC3 5.1", () => {
      const args = liveRunArguments(
        base({ audio: { action: "transcode", codec: "eac3", channels: 6 } }),
      );
      const map = args.lastIndexOf("-map");
      expect(args.slice(map, map + 8)).toEqual([
        "-map",
        "0:a:0",
        "-c:a",
        "eac3",
        "-ac",
        "6",
        "-b:a",
        "640000",
      ]);
    });
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

describe("live runs", () => {
  let dir: string;
  let inputPath: string;
  let duration: number;
  let boundaries: number[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thalia-live-run-"));
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
    const { keyframesSeconds } = await readKeyframeIndex(inputPath);
    if (probe.durationSeconds === null || keyframesSeconds === null) {
      throw new Error("Fixture probe returned no duration or keyframes.");
    }
    duration = probe.durationSeconds;
    boundaries = deriveSegmentTimeline(keyframesSeconds, duration);
    expect(boundaries.slice(0, 4)).toEqual([0, 3, 6, 9]);
    expect(boundaries.at(-1)).toBe(duration);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fixture = async (
    name: string,
    options: Parameters<typeof createVideoFixture>[1],
  ) => {
    const path = join(dir, name);
    if (!(await Bun.file(path).exists())) {
      await createVideoFixture(path, options);
    }
    const probe = await probeVideo(path);
    const { keyframesSeconds } = await readKeyframeIndex(path);
    if (probe.durationSeconds === null || keyframesSeconds === null) {
      throw new Error(`${name} probe returned no duration or keyframes.`);
    }
    return {
      path,
      boundaries: deriveSegmentTimeline(
        keyframesSeconds,
        probe.durationSeconds,
      ),
    };
  };

  /** Runs to the end and returns the run directory and the reported segments. */
  const runToEnd = async (name: string, run: Omit<LiveRun, "directory">) => {
    const directory = join(dir, name);
    await mkdir(directory);
    const ready: ReadySegment[] = [];
    const handle = startLiveRun({ ...run, directory }, (segments) =>
      ready.push(...segments),
    );
    expect(await handle.exited).toBe(0);
    const [first] = ready;
    if (first === undefined) throw new Error(`${name} wrote no segment.`);
    const file = (index: number) => Bun.file(join(directory, `${index}.m4s`));
    const offset = (index: number) => {
      const segment = ready.find((entry) => entry.index === index);
      if (segment === undefined) throw new Error(`No segment ${index}.`);
      return segment.fragmentOffset;
    };
    return {
      directory,
      segments: ready.map((segment) => segment.index),
      /** The init a session serves: the header of the run's first segment. */
      init: () => file(first.index).slice(0, first.fragmentOffset).bytes(),
      /** Writes what a client receives for one segment, init then fragment, and returns its path. */
      async served(index: number) {
        const path = join(directory, `served-${index}.mp4`);
        await Bun.write(path, [
          await this.init(),
          await file(index).slice(offset(index)).bytes(),
        ]);
        return path;
      },
    };
  };

  test("every segment of a run opens with the same init before its fragment", async () => {
    const { directory, segments } = await runToEnd("copy-headers", {
      inputPath,
      boundariesSeconds: boundaries,
      startIndex: 0,
      video: copy(),
    });
    const headers = await Promise.all(
      segments.map(async (index) => {
        const path = join(directory, `${index}.m4s`);
        return Bun.file(path)
          .slice(0, await fragmentOffset(path))
          .bytes();
      }),
    );
    for (const header of headers) {
      expect(Buffer.from(header).equals(headers[0] ?? new Uint8Array())).toBe(
        true,
      );
    }
  }, 30_000);

  test("a full copy run cuts every segment at its boundary", async () => {
    const full = await runToEnd("copy-0", {
      inputPath,
      boundariesSeconds: boundaries,
      startIndex: 0,
      video: copy(),
    });
    expect(full.segments).toEqual([0, 1, 2, 3]);
    for (const index of full.segments) {
      const joined = await full.served(index);
      const format = await probeFormat(joined);
      expect(format.startTime).toBeCloseTo(boundaries[index] ?? 0, 1);
      const keyframes = await ffprobeKeyframeTimes(joined);
      expect(keyframes[0]).toBeCloseTo(boundaries[index] ?? 0, 3);
    }
  }, 30_000);

  test("a copy restart at segment two reports only new segments with absolute timestamps", async () => {
    const run = {
      inputPath,
      boundariesSeconds: boundaries,
      video: copy(),
    };
    const full = await runToEnd("copy-full", { ...run, startIndex: 0 });
    const restart = await runToEnd("copy-2", { ...run, startIndex: 2 });
    expect(restart.segments).toEqual([2, 3]);
    expect(Buffer.from(await restart.init()).equals(await full.init())).toBe(
      true,
    );
    const joined = await restart.served(2);
    expect((await probeFormat(joined)).startTime).toBeCloseTo(6, 1);
    expect((await ffprobeKeyframeTimes(joined))[0]).toBeCloseTo(6, 3);
  }, 30_000);

  test("a restart on an uneven timeline cuts every later segment at its boundary", async () => {
    // Keyframes at 0, 5, 8 and 12 s: equal segments would hide a misplaced cut.
    const uneven = join(dir, "uneven.mkv");
    await runProcess([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=25:d=16",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-force_key_frames",
      "0,5,8,12",
      "-g",
      "1000",
      "-sc_threshold",
      "0",
      uneven,
    ]);
    const timeline = [0, 5, 8, 12, 16];
    for (const [name, video] of [
      ["uneven-copy", copy()],
      [
        "uneven-encode",
        transcode({ width: 320, height: 180, level: null, maxFrameRate: null }),
      ],
    ] as const) {
      const restart = await runToEnd(name, {
        inputPath: uneven,
        boundariesSeconds: timeline,
        startIndex: 1,
        video,
      });
      expect(restart.segments).toEqual([1, 2, 3]);
      for (const index of restart.segments) {
        const { pts } = await firstVideoPts(await restart.served(index));
        expect(pts).toBeCloseTo(timeline[index] ?? -1, 3);
      }
    }

    // The keyframes at 8 and 12 s sit inside the last segment, and inside
    // the only segment of a one-segment timeline; neither splits it.
    const lastSegment = await runToEnd("uneven-last", {
      inputPath: uneven,
      boundariesSeconds: [0, 5, 16],
      startIndex: 1,
      video: copy(),
    });
    expect(lastSegment.segments).toEqual([1]);
    const whole = await runToEnd("uneven-whole", {
      inputPath: uneven,
      boundariesSeconds: [0, 16],
      startIndex: 0,
      video: copy(),
    });
    expect(whole.segments).toEqual([0]);
  }, 60_000);

  test("a capped frame rate keeps every restart cut on its boundary", async () => {
    // 25 fps with a boundary at 4.04 s: under a 24 fps cap the restart's
    // first frame lands at 4.0417 s, after the boundary.
    const capped = join(dir, "capped.mkv");
    await runProcess([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=25:d=16",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-force_key_frames",
      "0,4.04,8,12",
      "-g",
      "1000",
      "-sc_threshold",
      "0",
      capped,
    ]);
    const timeline = [0, 4.04, 8, 12, 16];
    // Every codec this node's startup trial would offer; one that ignores
    // forced keyframes on this ffmpeg is never planned, so it is not here.
    const [cpu] = await runStartupTrial();
    expect(cpu?.codecs).toContain("h264");
    for (const codec of cpu?.codecs ?? []) {
      for (const startIndex of [0, 1]) {
        const run = await runToEnd(`capped-${codec}-${startIndex}`, {
          inputPath: capped,
          boundariesSeconds: timeline,
          startIndex,
          video: transcode({
            codec,
            profile: null,
            level: null,
            maxFrameRate: 24,
            width: 320,
            height: 180,
          }),
        });
        expect({ codec, startIndex, segments: run.segments }).toEqual({
          codec,
          startIndex,
          segments: [0, 1, 2, 3].slice(startIndex),
        });
        for (const index of run.segments) {
          const served = await run.served(index);
          const { pts = Number.NaN } = await firstVideoPts(served);
          const boundary = timeline[index] ?? Number.NaN;
          // Within one 24 fps frame of the boundary, and its only keyframe.
          expect(pts).toBeGreaterThanOrEqual(boundary);
          expect(pts - boundary).toBeLessThan(1 / 24);
          expect(await ffprobeKeyframeTimes(served)).toHaveLength(1);
        }
      }
    }
  }, 120_000);

  test.skipIf(!hasLibx265)(
    "an HEVC source transcodes to H.264 cut exactly on the timeline",
    async () => {
      const hevc = await fixture("hevc.mkv", {
        width: 640,
        height: 360,
        durationSeconds: 12,
        frameRate: 25,
        gopSeconds: 3,
        pattern: "testsrc2",
        videoCodec: "hevc",
      });
      expect(hevc.boundaries.slice(0, 4)).toEqual([0, 3, 6, 9]);
      const video = transcode({
        width: 426,
        height: 240,
        bitrate: 1_500_000,
        rung: ladder[4],
        level: null,
        maxFrameRate: null,
      });
      const full = await runToEnd("hevc-0", {
        inputPath: hevc.path,
        boundariesSeconds: hevc.boundaries,
        startIndex: 0,
        video,
      });
      expect(full.segments).toEqual([0, 1, 2, 3]);
      for (const index of full.segments) {
        const joined = await full.served(index);
        const [stream] = (await probeStreams(joined)).filter(
          (entry) => entry.codec_type === "video",
        );
        expect(stream).toMatchObject({
          codec_name: "h264",
          width: 426,
          height: 240,
          pix_fmt: "yuv420p",
        });
        const boundary = hevc.boundaries[index] ?? 0;
        expect(await firstVideoPts(joined)).toEqual({
          pts: boundary,
          dts: boundary,
        });
        const keyframes = await ffprobeKeyframeTimes(joined);
        expect(keyframes[0]).toBeCloseTo(boundary, 3);
        // One keyframe per segment: the forced one at its start.
        expect(keyframes).toHaveLength(1);
      }

      const restart = await runToEnd("hevc-2", {
        inputPath: hevc.path,
        boundariesSeconds: hevc.boundaries,
        startIndex: 2,
        video,
      });
      expect(restart.segments).toEqual([2, 3]);
      expect(Buffer.from(await restart.init()).equals(await full.init())).toBe(
        true,
      );
      const joined = await restart.served(2);
      expect(await firstVideoPts(joined)).toEqual({ pts: 6, dts: 6 });
      expect(await ffprobeKeyframeTimes(joined)).toHaveLength(1);
    },
    60_000,
  );

  test("an audio-only mismatch copies every video packet and downmixes to AAC stereo", async () => {
    const surround = await fixture("surround.mkv", {
      width: 640,
      height: 360,
      durationSeconds: 6,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
      audioCodec: "ac3",
      audioChannels: 6,
    });
    const run = {
      inputPath: surround.path,
      boundariesSeconds: surround.boundaries,
      startIndex: 0,
      video: copy(),
    };
    const copied = await runToEnd("surround-copy", run);
    const downmixed = await runToEnd("surround-aac", {
      ...run,
      audio: { action: "transcode", codec: "aac", channels: 2 },
    });
    // AC-3 has no header before its first packet; the copy proves the
    // per-segment header carries it.
    expect(
      (await probeStreams(await copied.served(0))).find(
        (entry) => entry.codec_type === "audio",
      ),
    ).toMatchObject({ codec_name: "ac3", channels: 6 });
    expect(downmixed.segments).toEqual(copied.segments);
    for (const index of downmixed.segments) {
      const joined = await downmixed.served(index);
      expect(await videoPacketHashes(joined)).toEqual(
        await videoPacketHashes(await copied.served(index)),
      );
      expect(
        (await probeStreams(joined)).find(
          (entry) => entry.codec_type === "audio",
        ),
      ).toMatchObject({ codec_name: "aac", channels: 2 });
    }
  }, 60_000);

  test("a six channel source encodes EAC3 5.1", async () => {
    const lossless = await fixture("lossless.mkv", {
      width: 320,
      height: 180,
      durationSeconds: 3,
      frameRate: 25,
      audioCodec: "flac",
      audioChannels: 6,
    });
    const run = await runToEnd("lossless-eac3", {
      inputPath: lossless.path,
      boundariesSeconds: lossless.boundaries,
      startIndex: 0,
      video: copy(),
      audio: { action: "transcode", codec: "eac3", channels: 6 },
    });
    expect(
      (await probeStreams(await run.served(0))).find(
        (entry) => entry.codec_type === "audio",
      ),
    ).toMatchObject({ codec_name: "eac3", channels: 6 });
  }, 30_000);

  test.skipIf(!hasLibx265 || !hasZscale)(
    "a 10-bit PQ source tone maps to 8-bit BT.709",
    async () => {
      const pq = await fixture("pq.mkv", {
        width: 640,
        height: 360,
        durationSeconds: 3,
        frameRate: 25,
        pattern: "testsrc2",
        videoCodec: "hevc",
        hdr: "hdr10",
      });
      const run = await runToEnd("pq-sdr", {
        inputPath: pq.path,
        boundariesSeconds: pq.boundaries,
        startIndex: 0,
        video: transcode({
          width: 640,
          height: 360,
          toneMap: "hdr10",
          level: null,
          maxFrameRate: null,
        }),
      });
      const [stream] = await probeStreams(await run.served(0));
      expect(stream).toMatchObject({
        codec_name: "h264",
        pix_fmt: "yuv420p",
        color_transfer: "bt709",
      });
    },
    60_000,
  );

  test("a throttled run reports the first segment and goes quiet after kill", async () => {
    const runDir = join(dir, "run-throttled");
    await mkdir(runDir);
    const batches: number[][] = [];
    const startedAt = Date.now();
    const handle = startLiveRun(
      {
        inputPath,
        boundariesSeconds: boundaries,
        startIndex: 0,
        directory: runDir,
        video: copy(),
        readRate: { rate: 1, initialBurstSeconds: 3.5 },
      },
      (segments) => batches.push(segments.map((segment) => segment.index)),
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
      const batches: ReadySegment[][] = [];
      const handle = startLiveRun(
        {
          inputPath: join(dir, "missing.mkv"),
          boundariesSeconds: boundaries,
          startIndex: 0,
          directory: runDir,
          video: copy(),
        },
        (segments) => batches.push(segments),
      );
      const code = await handle.exited;
      expect(code).not.toBeNull();
      expect(code).not.toBe(0);
      expect(batches).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain("run.failed");
    } finally {
      spy.mockRestore();
    }
  }, 15_000);

  // The dovi_rpu bitstream filter arrived in ffmpeg 7.1; the runtime image has
  // it, the CI runner's apt ffmpeg 6.1 does not.
  const hasDoviFilter = Bun.spawnSync(["ffmpeg", "-hide_banner", "-bsfs"])
    .stdout.toString()
    .includes("dovi_rpu");

  test.skipIf(!hasDoviFilter || !hasLibx265)(
    "a Dolby Vision strip runs on a hevc copy and tags hvc1",
    async () => {
      // The source carries no RPU, so the filter is a no-op; the run proves
      // ffmpeg accepts dovi_rpu=strip=1 in copy mode.
      const hevc = await fixture("hevc-small.mkv", {
        width: 160,
        height: 90,
        durationSeconds: 4,
        frameRate: 25,
        gopSeconds: 2,
        videoCodec: "hevc",
      });
      const run = await runToEnd("hevc-dovi", {
        inputPath: hevc.path,
        boundariesSeconds: hevc.boundaries,
        startIndex: 0,
        video: copy("hevc", true),
      });
      expect(run.segments.length).toBe(hevc.boundaries.length - 1);
      const tag = await runProcess([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v",
        "-show_entries",
        "stream=codec_tag_string",
        "-of",
        "csv=p=0",
        "-i",
        await run.served(0),
      ]);
      expect(tag.trim()).toBe("hvc1");
    },
    30_000,
  );
});
