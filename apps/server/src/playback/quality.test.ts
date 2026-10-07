import { describe, expect, test } from "bun:test";
import type { PlaybackSource } from "./decisions.ts";
import type { CapabilityTable, ClientProfile } from "./policy.ts";
import {
  boxProfile,
  type QualityOptionsInput,
  qualityLadder,
  qualityOptions,
  rungName,
  sourceRungs,
} from "./quality.ts";

const profile: ClientProfile = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", profiles: ["high"], maxLevel: 51 }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: [],
  hdr: ["sdr"],
};

const source = (
  video: Partial<PlaybackSource["video"]> = {},
): PlaybackSource => ({
  container: "mp4",
  video: {
    codec: "h264",
    profile: "high",
    level: 41,
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    hdr: "sdr",
    ...video,
  },
  audio: [{ codec: "aac", channels: 2 }],
  subtitles: [],
});

const options = (
  part: Partial<QualityOptionsInput> = {},
): QualityOptionsInput => ({
  source: source(),
  profile,
  caps: { isLan: true },
  current: { durationSeconds: 120, timelineAligned: true },
  ...part,
});

describe("qualityLadder", () => {
  test("lists the ladder's rungs by name", () => {
    expect(qualityLadder().map(rungName)).toEqual([
      "2160p",
      "1080p",
      "720p",
      "480p",
      "360p",
      "240p",
    ]);
  });
});

describe("sourceRungs", () => {
  test("keeps a rung the source fits on one axis", () => {
    expect(sourceRungs({ width: 3840, height: 1600 }).map(rungName)).toEqual([
      "2160p",
      "1080p",
      "720p",
      "480p",
      "360p",
      "240p",
    ]);
  });

  test("drops rungs that upscale on both axes", () => {
    expect(sourceRungs({ width: 1920, height: 800 }).map(rungName)).toEqual([
      "1080p",
      "720p",
      "480p",
      "360p",
      "240p",
    ]);
  });
});

describe("boxProfile", () => {
  test("lowers every codec's frame box to the rung's", () => {
    const boxed = boxProfile(
      {
        ...profile,
        videoCodecs: [
          { codec: "h264", maxWidth: 3840 },
          { codec: "hevc", maxHeight: 100 },
        ],
      },
      { width: 1280, height: 720 },
    );
    expect(boxed.videoCodecs).toEqual([
      { codec: "h264", maxWidth: 1280, maxHeight: 720 },
      { codec: "hevc", maxWidth: 1280, maxHeight: 100 },
    ]);
    expect(profile.videoCodecs[0]?.maxWidth).toBeUndefined();
  });
});

describe("qualityOptions", () => {
  const version720 = {
    id: "v-720",
    durationSeconds: 120,
    timelineAligned: true,
    source: source({ width: 1280, height: 720, bitrate: 2_500_000 }),
  };

  test("skips a rung the current File plays as is and offers Original", () => {
    const quality = qualityOptions(options());
    expect(quality.original).toEqual({
      name: "1080p",
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
    });
    expect(quality.rungs.map((rung) => rung.name)).toEqual([
      "720p",
      "480p",
      "360p",
      "240p",
    ]);
    expect(quality.rungs.every((rung) => rung.source === "transcode")).toBe(
      true,
    );
    expect(quality.rungs.every((rung) => rung.available)).toBe(true);
  });

  test("a stored rung beats a Version, which beats transcode", () => {
    const stored = qualityOptions(
      options({
        versions: [version720],
        pickStored: () => ({
          variantIds: ["stored-720"],
          bitrate: 4_000_000,
        }),
      }),
    );
    // The 720p Version also fits the rung, but stored resolves first.
    expect(stored.rungs.find((rung) => rung.name === "720p")).toMatchObject({
      source: "stored",
      bitrate: 4_000_000,
      storedVariantIds: ["stored-720"],
    });
    const noStored = qualityOptions(
      options({
        versions: [version720],
        pickStored: () => ({ variantIds: [], bitrate: null }),
      }),
    );
    expect(noStored.rungs.find((rung) => rung.name === "720p")).toMatchObject({
      source: "version",
      versionId: "v-720",
      bitrate: 2_500_000,
    });
    expect(noStored.rungs.find((rung) => rung.name === "480p")?.source).toBe(
      "transcode",
    );
  });

  test("a Version beats transcode only when its duration is within 5 s", () => {
    const off = { ...version720, durationSeconds: 130 };
    const quality = qualityOptions(options({ versions: [off] }));
    expect(quality.rungs.find((rung) => rung.name === "720p")?.source).toBe(
      "transcode",
    );
    const near = { ...version720, durationSeconds: 124 };
    const included = qualityOptions(options({ versions: [near] }));
    expect(included.rungs.find((rung) => rung.name === "720p")?.source).toBe(
      "version",
    );
  });

  test("a transcode rung is unavailable when no live path exists", () => {
    const nothing: CapabilityTable = {
      cpu: { codecs: [], toneMapping: [] },
    };
    const quality = qualityOptions(options({ capabilities: nothing }));
    expect(quality.rungs.map((rung) => rung.available)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("a 2160p transcode needs the CPU 4K opt-in", () => {
    // The client can't decode this source's profile; its decoder still takes
    // a 4K transcode output, so only the CPU 4K gate stops the option.
    const source4k = source({
      width: 3840,
      height: 2160,
      profile: "high10",
      bitrate: 20_000_000,
    });
    const gated = qualityOptions(options({ source: source4k }));
    expect(gated.rungs.find((rung) => rung.name === "2160p")).toMatchObject({
      source: "transcode",
      available: false,
    });
    const allowed = qualityOptions(
      options({ source: source4k, allowCpu4k: true }),
    );
    expect(allowed.rungs.find((rung) => rung.name === "2160p")).toMatchObject({
      source: "transcode",
      available: true,
    });
  });

  test("a 60 fps pick keeps the rung and prices the frame-rate factor", () => {
    const quality = qualityOptions(
      options({ source: source({ frameRate: 60 }) }),
    );
    // The box alone selects the rung; a rung-bitrate cap would drop it.
    expect(quality.rungs.find((rung) => rung.name === "720p")).toMatchObject({
      source: "transcode",
      available: true,
      bitrate: 6_000_000,
    });
  });

  test("original is null when the source must transcode", () => {
    const hevc = source({ codec: "hevc", profile: "main10" });
    const quality = qualityOptions(options({ source: hevc }));
    expect(quality.original).toBeNull();
    expect(quality.rungs.every((rung) => rung.source === "transcode")).toBe(
      true,
    );
  });
});
