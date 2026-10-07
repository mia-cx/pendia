import { describe, expect, test } from "bun:test";
import {
  backendPreference,
  type CapabilityTable,
  cpuCapabilities,
  effectiveCap,
  type Hdr,
  ladder,
  outputFitsLevel,
  outputFrameRateLimit,
  type PlaybackCaps,
  selectBackend,
  selectLadderRung,
} from "./policy.ts";

describe("effectiveCap", () => {
  test.each([
    [20_000_000, 10_000_000, 6_000_000],
    [20_000_000, 6_000_000, 10_000_000],
    [10_000_000, 20_000_000, 6_000_000],
    [10_000_000, 6_000_000, 20_000_000],
    [6_000_000, 20_000_000, 10_000_000],
    [6_000_000, 10_000_000, 20_000_000],
  ])(
    "returns the lowest of global %i, user %i, session %i",
    (globalDefault, userOverride, sessionRequest) => {
      expect(
        effectiveCap({
          globalDefault,
          userOverride,
          sessionRequest,
          isLan: false,
        }),
      ).toBe(6_000_000);
    },
  );

  const partial: [Omit<PlaybackCaps, "isLan">, number | null][] = [
    [{ globalDefault: 10_000_000 }, 10_000_000],
    [{ userOverride: 10_000_000 }, 10_000_000],
    [{ sessionRequest: 10_000_000 }, 10_000_000],
    [{ globalDefault: 10_000_000, userOverride: null }, 10_000_000],
    [{ globalDefault: 6_000_000, userOverride: 6_000_000 }, 6_000_000],
    [
      {
        globalDefault: 6_000_000,
        userOverride: 6_000_000,
        sessionRequest: 20_000_000,
      },
      6_000_000,
    ],
    [{ globalDefault: null, userOverride: null, sessionRequest: null }, null],
    [{}, null],
  ];
  test.each(partial)(
    "keeps lone caps, ties and empty inputs",
    (caps, expected) => {
      expect(effectiveCap({ ...caps, isLan: false })).toBe(expected);
    },
  );

  const lan: Omit<PlaybackCaps, "isLan">[] = [
    {
      globalDefault: 3_000_000,
      userOverride: 1_500_000,
      sessionRequest: 6_000_000,
    },
    { globalDefault: 1_500_000 },
    {},
  ];
  test.each(lan)("returns null on LAN regardless of caps", (caps) => {
    expect(effectiveCap({ ...caps, isLan: true })).toBeNull();
  });
});

describe("selectLadderRung", () => {
  test("ladder holds six named rates and bounding boxes", () => {
    expect(ladder).toEqual([
      { name: "2160p", bitrate: 25_000_000, width: 3840, height: 2160 },
      { name: "1080p", bitrate: 8_000_000, width: 1920, height: 1080 },
      { name: "720p", bitrate: 4_000_000, width: 1280, height: 720 },
      { name: "480p", bitrate: 2_000_000, width: 854, height: 480 },
      { name: "360p", bitrate: 800_000, width: 640, height: 360 },
      { name: "240p", bitrate: 300_000, width: 426, height: 240 },
    ]);
  });

  test("returns the top rung when uncapped", () => {
    expect(selectLadderRung(null)).toEqual({
      name: "2160p",
      bitrate: 25_000_000,
      width: 3840,
      height: 2160,
    });
  });

  const caps: [number, (typeof ladder)[number]["name"] | undefined][] = [
    [25_000_000, "2160p"],
    [24_999_999, "1080p"],
    [8_000_000, "1080p"],
    [7_999_999, "720p"],
    [4_000_000, "720p"],
    [3_999_999, "480p"],
    [2_000_000, "480p"],
    [1_999_999, "360p"],
    [800_000, "360p"],
    [799_999, "240p"],
    [500_000, "240p"],
    [300_000, "240p"],
    [299_999, undefined],
  ];
  test.each(caps)("cap %i picks the first fitting rung", (cap, expected) => {
    expect(selectLadderRung(cap)?.name).toBe(expected);
  });
});

describe("selectBackend", () => {
  test("lists backends in preference order", () => {
    expect(backendPreference).toEqual([
      "qsv",
      "vaapi",
      "nvenc",
      "vulkan",
      "cpu",
    ]);
  });

  test.each(["h264", "hevc", "av1"])("cpu asserts %s", (codec) => {
    expect(selectBackend(cpuCapabilities, codec)).toBe("cpu");
  });

  const hdrFlavors: Exclude<Hdr, "sdr">[] = [
    "hdr10",
    "hdr10+",
    "hlg",
    "dolby-vision",
  ];
  test.each(hdrFlavors)("cpu tone maps %s", (toneMap) => {
    expect(selectBackend(cpuCapabilities, "hevc", toneMap)).toBe("cpu");
  });

  test("returns undefined for an unasserted codec", () => {
    expect(selectBackend(cpuCapabilities, "vp9")).toBeUndefined();
  });

  test("prefers qsv when every backend asserts the codec", () => {
    const table: CapabilityTable = {
      qsv: { codecs: ["h264"], toneMapping: [] },
      vaapi: { codecs: ["h264"], toneMapping: [] },
      nvenc: { codecs: ["h264"], toneMapping: [] },
      vulkan: { codecs: ["h264"], toneMapping: [] },
      cpu: { codecs: ["h264"], toneMapping: [] },
    };
    expect(selectBackend(table, "h264")).toBe("qsv");
  });

  test("falls to vaapi when qsv lacks the codec", () => {
    const table: CapabilityTable = {
      qsv: { codecs: ["h264"], toneMapping: [] },
      vaapi: { codecs: ["hevc", "h264"], toneMapping: [] },
      nvenc: { codecs: ["hevc"], toneMapping: [] },
      vulkan: { codecs: ["hevc"], toneMapping: [] },
      cpu: { codecs: ["hevc"], toneMapping: [] },
    };
    expect(selectBackend(table, "hevc")).toBe("vaapi");
  });

  test("skips backends that lack the requested tone map", () => {
    const toNvenc: CapabilityTable = {
      qsv: { codecs: ["hevc"], toneMapping: [] },
      vaapi: { codecs: ["hevc"], toneMapping: [] },
      nvenc: { codecs: ["hevc"], toneMapping: ["hdr10"] },
      vulkan: { codecs: ["hevc"], toneMapping: ["hdr10"] },
      cpu: { codecs: ["hevc"], toneMapping: ["hdr10"] },
    };
    expect(selectBackend(toNvenc, "hevc", "hdr10")).toBe("nvenc");
    const toVulkan: CapabilityTable = {
      ...toNvenc,
      nvenc: { codecs: ["hevc"], toneMapping: [] },
    };
    expect(selectBackend(toVulkan, "hevc", "hdr10")).toBe("vulkan");
    const toCpu: CapabilityTable = {
      ...toVulkan,
      vulkan: { codecs: ["hevc"], toneMapping: [] },
    };
    expect(selectBackend(toCpu, "hevc", "hdr10")).toBe("cpu");
  });

  test("returns undefined when no backend asserts the tone map", () => {
    const table: CapabilityTable = {
      qsv: { codecs: ["hevc"], toneMapping: [] },
      vaapi: { codecs: ["hevc"], toneMapping: [] },
      nvenc: { codecs: ["hevc"], toneMapping: [] },
      vulkan: { codecs: ["hevc"], toneMapping: [] },
      cpu: { codecs: ["hevc"], toneMapping: [] },
    };
    expect(selectBackend(table, "hevc", "hdr10")).toBeUndefined();
  });

  test("forceCpu bypasses hardware that asserts the tone map", () => {
    const table: CapabilityTable = {
      qsv: { codecs: ["hevc"], toneMapping: ["dolby-vision"] },
      vaapi: { codecs: ["hevc"], toneMapping: ["dolby-vision"] },
      cpu: { codecs: ["hevc"], toneMapping: ["dolby-vision"] },
    };
    expect(selectBackend(table, "hevc", "dolby-vision", true)).toBe("cpu");
  });
});

describe("outputFitsLevel", () => {
  const cases: [string, number, number, number, number, boolean][] = [
    ["h264", 30, 720, 576, 10_000_000, true],
    ["h264", 30, 720, 576, 10_000_001, false],
    ["h264", 30, 1920, 1080, 6_000_000, false],
    ["h264", 30, 2112, 16, 1_500_000, false],
    ["hevc", 93, 1920, 1080, 6_000_000, false],
    ["hevc", 123, 1920, 1080, 20_000_000, true],
    ["av1", 8, 1920, 1080, 20_000_000, false],
    ["av1", 9, 1920, 1080, 20_000_000, true],
    ["vp9", 41, 1920, 1080, 6_000_000, false],
  ];
  test.each(cases)(
    "checks %s level %i at %ix%i and %i bps",
    (codec, level, width, height, bitrate, fits) => {
      expect(outputFitsLevel(codec, level, width, height, bitrate)).toBe(fits);
    },
  );
});

describe("outputFrameRateLimit", () => {
  const cases: [string, number, number, number, number, number | undefined][] =
    [
      ["h264", 41, 1920, 1080, 20_000_000, 30],
      ["h264", 42, 1920, 1080, 20_000_000, 64],
      ["hevc", 120, 1920, 1080, 10_000_000, 32],
      ["hevc", 123, 1920, 1080, 20_000_000, 64],
      ["av1", 8, 1920, 1080, 10_000_000, 34],
      ["av1", 9, 1920, 1080, 20_000_000, 68],
      ["av1", 9, 640, 360, 3_000_000, 300],
      ["av1", 5, 320, 180, 1_500_000, 150],
      ["h264", 30, 1920, 1080, 20_000_000, undefined],
    ];
  test.each(cases)(
    "caps %s level %i at %ix%i and %i bps",
    (codec, level, width, height, bitrate, fps) => {
      expect(outputFrameRateLimit(codec, level, width, height, bitrate)).toBe(
        fps,
      );
    },
  );
});
