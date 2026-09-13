import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createVideoFixture, withVideoFixture } from "./fixtures.ts";
import { createKeyframeFixture } from "./keyframe-fixtures.ts";
import { parseProbeOutput, probeVideo } from "./probe.ts";

interface IndependentStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
}

async function ffprobeStreams(path: string): Promise<IndependentStream[]> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_streams", "-of", "json", "-i", path],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [output, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed (${exitCode})`);
  }
  const parsed: { streams: IndependentStream[] } = JSON.parse(output);
  return parsed.streams;
}

describe("probeVideo", () => {
  test("normalizes a real generated fixture", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "Fixture.2160p.WEB.mkv");
      await createVideoFixture(file, { chapters: true });
      const result = await probeVideo(file);
      const independent = await ffprobeStreams(file);

      expect(
        result.streams.map((stream) => ({
          index: stream.index,
          codec: stream.codec,
          kind: stream.kind,
        })),
      ).toEqual(
        independent
          .filter(
            (
              stream,
            ): stream is IndependentStream & {
              codec_type: "video" | "audio" | "subtitle";
            } =>
              stream.codec_type === "video" ||
              stream.codec_type === "audio" ||
              stream.codec_type === "subtitle",
          )
          .map((stream) => ({
            index: stream.index,
            codec: stream.codec_name ?? "unknown",
            kind: stream.codec_type,
          })),
      );
      expect(result.streams.map((stream) => stream.codec)).toEqual([
        "h264",
        "aac",
        "subrip",
      ]);

      const video = result.streams[0];
      expect(video?.kind).toBe("video");
      expect(video?.width).toBe(1920);
      expect(video?.height).toBe(1080);

      const audio = result.streams[1];
      expect(audio?.kind).toBe("audio");
      expect(audio?.sampleRate).toBe(48000);
      expect(audio?.channels).toBe(2);
      expect(audio?.language).toBe("eng");
      expect(audio?.disposition.default).toBe(true);

      const subtitle = result.streams[2];
      expect(subtitle?.kind).toBe("subtitle");
      expect(subtitle?.language).toBe("nld");
      expect(subtitle?.disposition.forced).toBe(true);

      expect(result.container).toBe("mkv");
      expect(result.durationSeconds).toBeGreaterThan(0.5);
      expect(result.durationSeconds).toBeLessThanOrEqual(1.5);
      expect(result.chapters).toEqual([
        { title: "Opening", startSeconds: 0, endSeconds: 1 },
      ]);
    });
  });

  test("reports container mov for a real remuxed MOV file", async () => {
    await withVideoFixture(async (dir) => {
      const mkv = join(dir, "Fixture.mkv");
      await createVideoFixture(mkv);
      const mov = join(dir, "Fixture.mov");
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          mkv,
          "-map",
          "0:v:0",
          "-c",
          "copy",
          "-f",
          "mov",
          mov,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, , exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`ffmpeg failed (${exitCode}): ${stderr.trim()}`);
      }
      const result = await probeVideo(mov);
      expect(result.container).toBe("mov");
      const independent = await ffprobeStreams(mov);
      expect(result.streams.map((stream) => stream.index)).toEqual(
        independent
          .filter(
            (stream) =>
              stream.codec_type === "video" ||
              stream.codec_type === "audio" ||
              stream.codec_type === "subtitle",
          )
          .map((stream) => stream.index),
      );
      expect(result.streams[0]).toMatchObject({ kind: "video", codec: "h264" });
    });
  });

  test("attaches the container keyframe index to a real MP4", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "Fixture.mp4");
      await createKeyframeFixture(file);
      const result = await probeVideo(file);
      expect(result.keyframesSeconds).toEqual([0, 2, 4, 6, 8, 10]);
      expect(result.container).toBe("mp4");
    });
  });

  test("returns a null index for fragmented MP4 with valid metadata", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "Fixture.mp4");
      await createKeyframeFixture(file, { fragmented: true });
      const result = await probeVideo(file);
      expect(result.keyframesSeconds).toBeNull();
      expect(result.durationSeconds).toBeGreaterThan(0);
      expect(result.streams[0]).toMatchObject({ kind: "video", codec: "h264" });
    });
  });

  test("rejects a nonexistent file", async () => {
    await withVideoFixture(async (dir) => {
      await expect(probeVideo(join(dir, "missing.mkv"))).rejects.toThrow(
        "ffprobe failed",
      );
    });
  });

  test("rejects non-media content", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "notes.mkv");
      await writeFile(file, "not media\n");
      await expect(probeVideo(file)).rejects.toThrow();
    });
  });
});

describe("parseProbeOutput", () => {
  test("normalizes N/A, zero and invalid fields to null", () => {
    const result = parseProbeOutput({
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "hevc",
          profile: "Main 10",
          level: -99,
          width: "N/A",
          height: 0,
          avg_frame_rate: "0/0",
          r_frame_rate: "25/1",
          bit_rate: "N/A",
          duration: "N/A",
          color_transfer: "smpte2084",
        },
      ],
      format: { format_name: "matroska,webm", duration: "N/A" },
    });
    const stream = result.streams[0];
    expect(stream?.profile).toBe("main10");
    expect(stream?.level).toBeNull();
    expect(stream?.width).toBeNull();
    expect(stream?.height).toBeNull();
    expect(stream?.frameRateNumerator).toBe(25);
    expect(stream?.frameRateDenominator).toBe(1);
    expect(stream?.bitrate).toBeNull();
    expect(stream?.hdr).toBe("hdr10");
    expect(result.container).toBe("mkv");
    expect(result.durationSeconds).toBeNull();
    expect(result.keyframesSeconds).toBeNull();
  });

  test("prefers Dolby Vision, then HDR10+, then transfer-based HDR", () => {
    const stream = (overrides: Record<string, unknown>) => ({
      index: 0,
      codec_type: "video",
      codec_name: "hevc",
      ...overrides,
    });
    expect(
      parseProbeOutput({
        streams: [
          stream({
            color_transfer: "smpte2084",
            side_data_list: [
              { side_data_type: "DOVI configuration record", dv_profile: 8 },
              { side_data_type: "HDR Dynamic Metadata SMPTE2094-40" },
            ],
          }),
        ],
      }).streams[0],
    ).toMatchObject({ hdr: "dolby-vision", dvProfile: 8 });
    expect(
      parseProbeOutput({
        streams: [
          stream({
            color_transfer: "smpte2084",
            side_data_list: [
              { side_data_type: "HDR Dynamic Metadata SMPTE2094-40" },
            ],
          }),
        ],
      }).streams[0],
    ).toMatchObject({ hdr: "hdr10+", dvProfile: null });
    expect(
      parseProbeOutput({
        streams: [stream({ color_transfer: "arib-std-b67" })],
      }).streams[0],
    ).toMatchObject({ hdr: "hlg" });
    expect(
      parseProbeOutput({ streams: [stream({})] }).streams[0],
    ).toMatchObject({ hdr: "sdr", dvProfile: null });
  });

  test("leaves hdr and dvProfile null on non-video streams", () => {
    const result = parseProbeOutput({
      streams: [
        {
          index: 0,
          codec_type: "audio",
          codec_name: "aac",
          side_data_list: [
            { side_data_type: "DOVI configuration record", dv_profile: 8 },
          ],
        },
      ],
    });
    expect(result.streams[0]).toMatchObject({ hdr: null, dvProfile: null });
  });

  test("skips unsupported codec types and keeps indexes with gaps", () => {
    const result = parseProbeOutput({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264" },
        { index: 1, codec_type: "data", codec_name: "bin_data" },
        { index: 2, codec_type: "audio", codec_name: "aac" },
        { index: 3, codec_type: "attachment", codec_name: "ttf" },
      ],
    });
    expect(result.streams.map((stream) => stream.index)).toEqual([0, 2]);
    expect(result.streams.map((stream) => stream.kind)).toEqual([
      "video",
      "audio",
    ]);
  });

  test("defaults codec to unknown and keeps bitrate as a decimal string", () => {
    const result = parseProbeOutput({
      streams: [{ index: 0, codec_type: "subtitle", bit_rate: "3840" }],
    });
    expect(result.streams[0]?.codec).toBe("unknown");
    expect(result.streams[0]?.bitrate).toBe("3840");
  });

  test("keeps large bitrate strings exact and rejects unsafe numbers", () => {
    expect(
      parseProbeOutput({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            bit_rate: "9007199254740993",
          },
        ],
      }).streams[0]?.bitrate,
    ).toBe("9007199254740993");
    expect(
      parseProbeOutput({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            bit_rate: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      }).streams[0]?.bitrate,
    ).toBeNull();
  });

  test("throws on missing, negative or fractional stream indexes", () => {
    expect(() =>
      parseProbeOutput({ streams: [{ codec_type: "video" }] }),
    ).toThrow("Invalid stream index.");
    expect(() =>
      parseProbeOutput({ streams: [{ index: -1, codec_type: "video" }] }),
    ).toThrow("Invalid stream index.");
    expect(() =>
      parseProbeOutput({ streams: [{ index: 1.5, codec_type: "video" }] }),
    ).toThrow("Invalid stream index.");
  });

  test("skips unsupported streams before validating indexes", () => {
    expect(
      parseProbeOutput({ streams: [{ codec_type: "data" }] }).streams,
    ).toEqual([]);
  });

  test("throws on duplicate stream indexes among supported streams", () => {
    expect(() =>
      parseProbeOutput({
        streams: [
          { index: 0, codec_type: "video", codec_name: "h264" },
          { index: 0, codec_type: "audio", codec_name: "aac" },
        ],
      }),
    ).toThrow("Duplicate stream index.");
  });

  test("distinguishes QuickTime MOV from shared-demuxer mp4 aliases", () => {
    const streams = [{ index: 0, codec_type: "video", codec_name: "h264" }];
    expect(
      parseProbeOutput({
        streams,
        format: {
          format_name: "mov,mp4,m4a,3gp,3g2,mj2",
          tags: { major_brand: "qt  " },
        },
      }).container,
    ).toBe("mov");
    expect(
      parseProbeOutput({
        streams,
        format: {
          format_name: "mov,mp4,m4a,3gp,3g2,mj2",
          tags: { major_brand: "isom" },
        },
      }).container,
    ).toBe("mp4");
  });

  test("throws on a chapter with invalid timing", () => {
    expect(() =>
      parseProbeOutput({
        streams: [],
        chapters: [{ start_time: "5.0", end_time: "1.0" }],
      }),
    ).toThrow();
    expect(() =>
      parseProbeOutput({
        streams: [],
        chapters: [{ start_time: "N/A", end_time: "1.0" }],
      }),
    ).toThrow();
  });

  test("falls back to the maximum stream duration", () => {
    const result = parseProbeOutput({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", duration: "2.5" },
        { index: 1, codec_type: "audio", codec_name: "aac", duration: "9.25" },
      ],
      format: { format_name: "mp4" },
    });
    expect(result.container).toBe("mp4");
    expect(result.durationSeconds).toBe(9.25);
  });
});
