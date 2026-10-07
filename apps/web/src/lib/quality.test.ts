import { describe, expect, test } from "bun:test";
import {
  boostLabel,
  formatMbps,
  playingName,
  type Quality,
  qualityEntries,
  qualityValue,
  speedLabel,
} from "./quality.ts";

const quality = (part: Partial<Quality> = {}): Quality =>
  ({
    original: {
      name: "2160p",
      width: 3840,
      height: 2160,
      bitrate: 40_000_000,
    },
    rungs: [
      {
        name: "1080p",
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        source: "stored",
        versionId: null,
        storedVariantIds: ["stored-1"],
        available: true,
      },
      {
        name: "720p",
        width: 1280,
        height: 720,
        bitrate: 2_500_000,
        source: "version",
        versionId: "v-720",
        storedVariantIds: [],
        available: true,
      },
      {
        name: "480p",
        width: 854,
        height: 480,
        bitrate: 3_000_000,
        source: "transcode",
        versionId: null,
        storedVariantIds: [],
        available: false,
      },
    ],
    storedVariantIds: ["stored-1"],
    ...part,
  }) as Quality;

describe("labels", () => {
  test("speed and boost labels follow the menu's wording", () => {
    expect(speedLabel(1)).toBe("Normal");
    expect(speedLabel(1.5)).toBe("1.5×");
    expect(speedLabel(0.5)).toBe("0.5×");
    expect(boostLabel(0)).toBe("Off");
    expect(boostLabel(2)).toBe("+200%");
    expect(boostLabel(0.5)).toBe("+50%");
  });

  test("formatMbps keeps at most one decimal", () => {
    expect(formatMbps(8_000_000)).toBe("8 Mbit/s");
    expect(formatMbps(1_500_000)).toBe("1.5 Mbit/s");
    expect(formatMbps(3_040_000)).toBe("3 Mbit/s");
  });
});

describe("playingName", () => {
  test("names the smallest box containing the frame", () => {
    expect(playingName({ width: 1920, height: 1080 }, quality())).toBe("1080p");
    // The original's box covers a wide 4K frame the rungs don't.
    expect(playingName({ width: 3840, height: 1600 }, quality())).toBe("2160p");
    expect(playingName({ width: 4096, height: 2000 }, quality())).toBe("2000p");
    expect(playingName(null, quality())).toBeNull();
  });
});

describe("qualityValue", () => {
  test("reads Auto, Original or the picked rung", () => {
    const state = (quality: string, size = { width: 1920, height: 1080 }) => ({
      quality,
      videoSize: size,
    });
    expect(qualityValue(state("auto"), quality())).toBe("Auto · 1080p");
    expect(qualityValue({ quality: "auto", videoSize: null }, quality())).toBe(
      "Auto",
    );
    expect(qualityValue(state("original"), quality())).toBe("Original");
    // A rung pick names the rung that's playing, and the pick before a frame.
    expect(
      qualityValue(state("720p", { width: 1280, height: 720 }), quality()),
    ).toBe("720p");
    expect(qualityValue({ quality: "720p", videoSize: null }, quality())).toBe(
      "720p",
    );
    // A persisted rung taller than the source still names what plays.
    expect(qualityValue(state("2160p"), quality())).toBe("1080p");
  });
});

describe("qualityEntries", () => {
  test("lists Auto, Original and the rungs with their details", () => {
    const entries = qualityEntries(quality(), [
      { id: "v-720", label: "Director's cut" },
    ]);
    expect(entries).toEqual([
      { value: "auto", label: "Auto" },
      {
        value: "original",
        label: "Original",
        detail: "2160p · 40 Mbit/s",
      },
      {
        value: "1080p",
        label: "1080p",
        detail: "Stored · 8 Mbit/s",
        disabled: false,
      },
      {
        value: "720p",
        label: "720p",
        detail: "Director's cut",
        disabled: false,
        versionId: "v-720",
      },
      {
        value: "480p",
        label: "480p",
        detail: "Transcode · 3 Mbit/s",
        disabled: true,
      },
    ]);
  });

  test("no original means no Original option", () => {
    const entries = qualityEntries(quality({ original: null }), []);
    expect(entries.map((entry) => entry.value)).toEqual([
      "auto",
      "1080p",
      "720p",
      "480p",
    ]);
  });
});
