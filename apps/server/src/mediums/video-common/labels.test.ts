import { describe, expect, test } from "bun:test";
import { videoVersionLabel } from "./labels.ts";
import type { ProbeStream } from "./probe.ts";

const stream = (overrides: Partial<ProbeStream>): ProbeStream => ({
  index: 0,
  kind: "video",
  codec: "h264",
  profile: null,
  level: null,
  language: null,
  title: null,
  bitrate: null,
  disposition: {},
  width: null,
  height: null,
  frameRateNumerator: null,
  frameRateDenominator: null,
  hdr: null,
  dvProfile: null,
  channels: null,
  channelLayout: null,
  sampleRate: null,
  ...overrides,
});

const fixture = (
  video: Partial<ProbeStream>,
  audio?: Partial<ProbeStream>,
) => ({
  streams: [
    stream({ index: 0, kind: "video", width: 1920, height: 1080, ...video }),
    stream({
      index: 1,
      kind: "audio",
      codec: "aac",
      disposition: { default: true },
      ...audio,
    }),
  ],
});

describe("videoVersionLabel", () => {
  test("labels from the probe, not a misleading filename", () => {
    expect(
      videoVersionLabel("Movie.2160p.HEVC.mkv", fixture({ height: 1080 })),
    ).toBe("1080p · H.264 · AAC");
  });

  test("labels 4K by resolution", () => {
    expect(
      videoVersionLabel(
        "Movie.mkv",
        fixture({ width: 3840, height: 2160, codec: "hevc" }),
      ),
    ).toBe("4K · HEVC · AAC");
  });

  test("leads with an explicit edition tag", () => {
    expect(
      videoVersionLabel(
        "Alien {edition-Director's Cut}.mkv",
        fixture({ height: 1080 }),
      ),
    ).toBe("Director's Cut · 1080p · H.264 · AAC");
  });

  test("includes HDR when the video stream carries it", () => {
    expect(
      videoVersionLabel(
        "Movie.mkv",
        fixture({ width: 3840, height: 2160, codec: "hevc", hdr: "hdr10" }),
      ),
    ).toBe("4K · HEVC · HDR10 · AAC");
  });

  test("prefers the default non-picture video stream", () => {
    const label = videoVersionLabel("Movie.mkv", {
      streams: [
        stream({
          index: 0,
          kind: "video",
          codec: "mjpeg",
          disposition: { attached_pic: true, default: true },
        }),
        stream({ index: 1, kind: "video", width: 1280, height: 720 }),
        stream({
          index: 2,
          kind: "video",
          codec: "hevc",
          width: 3840,
          height: 2160,
          hdr: "hdr10",
          disposition: { default: true },
        }),
        stream({
          index: 3,
          kind: "audio",
          codec: "aac",
          disposition: { default: true },
        }),
      ],
    });
    expect(label).toBe("4K · HEVC · HDR10 · AAC");
  });

  test("uses no arbitrary filename pieces and falls back to Video", () => {
    const label = videoVersionLabel(
      "Movie.1999.DVDRip.mkv",
      fixture({ height: 720 }),
    );
    expect(label).not.toContain("1999");
    expect(label).not.toContain("DVDRip");
    expect(videoVersionLabel("Movie.mkv", { streams: [] })).toBe("Video");
  });
});
