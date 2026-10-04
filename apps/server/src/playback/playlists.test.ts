import { describe, expect, test } from "bun:test";
import * as HLS from "hls-parser";
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  buildSubtitlePlaylist,
  codecString,
  type HlsName,
  parseHlsName,
  segmentCount,
  variantCodecs,
} from "./playlists.ts";

HLS.setOptions({ strictMode: true });

describe("buildMasterPlaylist", () => {
  test("advertises one variant carrying the query", () => {
    const playlist = HLS.parse(
      buildMasterPlaylist(
        [
          {
            uri: "media.m3u8",
            bandwidth: 5_000_000,
            width: 1920,
            height: 1080,
            codecs: ["avc1.640028", "mp4a.40.2"],
          },
        ],
        "?token=t",
      ),
    );
    if (!playlist.isMasterPlaylist) {
      throw new Error("Expected a master playlist.");
    }
    expect(playlist.variants.length).toBe(1);
    const variant = playlist.variants[0];
    expect(variant?.uri).toBe("media.m3u8?token=t");
    expect(variant?.bandwidth).toBe(5_000_000);
    expect(variant?.resolution).toEqual({ width: 1920, height: 1080 });
    expect(variant?.codecs).toBe("avc1.640028,mp4a.40.2");
  });

  test("omits CODECS when the list is empty", () => {
    const playlist = HLS.parse(
      buildMasterPlaylist(
        [
          {
            uri: "media.m3u8",
            bandwidth: 5_000_000,
            width: 1920,
            height: 1080,
            codecs: [],
          },
        ],
        "",
      ),
    );
    if (!playlist.isMasterPlaylist) {
      throw new Error("Expected a master playlist.");
    }
    const variant = playlist.variants[0];
    expect(variant?.codecs).toBeUndefined();
    expect(variant?.uri).toBe("media.m3u8");
  });

  test("lists stored rungs in order, each with its own media playlist", () => {
    const playlist = HLS.parse(
      buildMasterPlaylist(
        [
          {
            uri: "low/media.m3u8",
            bandwidth: 1_160_000,
            width: 640,
            height: 360,
            codecs: ["avc1.64001E", "mp4a.40.2"],
          },
          {
            uri: "high/media.m3u8",
            bandwidth: 8_160_000,
            width: 1920,
            height: 1080,
            codecs: ["avc1.640028", "mp4a.40.2"],
          },
        ],
        "?token=t",
      ),
    );
    if (!playlist.isMasterPlaylist) {
      throw new Error("Expected a master playlist.");
    }
    expect(
      playlist.variants.map((variant) => [
        variant.uri,
        variant.bandwidth,
        variant.resolution?.height,
      ]),
    ).toEqual([
      ["low/media.m3u8?token=t", 1_160_000, 360],
      ["high/media.m3u8?token=t", 8_160_000, 1080],
    ]);
  });

  test("lists a WebVTT rendition per subtitle and links the variant to the group", () => {
    const text = buildMasterPlaylist(
      [
        {
          uri: "media.m3u8",
          bandwidth: 5_000_000,
          width: 1920,
          height: 1080,
          codecs: [],
        },
      ],
      "?token=t",
      [
        {
          index: 0,
          name: "Nederlands",
          language: "nld",
          default: false,
          forced: true,
        },
        {
          index: 2,
          name: 'Director "Commentary"',
          language: null,
          default: true,
          forced: false,
        },
      ],
    );
    const playlist = HLS.parse(text);
    if (!playlist.isMasterPlaylist) {
      throw new Error("Expected a master playlist.");
    }
    const variant = playlist.variants[0];
    expect(variant?.subtitles.map((rendition) => rendition.uri)).toEqual([
      "subs-0.m3u8?token=t",
      "subs-2.m3u8?token=t",
    ]);
    expect(variant?.subtitles[0]).toMatchObject({
      type: "SUBTITLES",
      groupId: "subs",
      name: "Nederlands",
      language: "nld",
      isDefault: false,
      autoselect: true,
      forced: true,
    });
    expect(variant?.subtitles[1]).toMatchObject({
      name: "Director Commentary",
      isDefault: true,
    });
    expect(variant?.subtitles[1]?.language).toBeUndefined();
    expect(text).toContain('SUBTITLES="subs"');
  });
});

describe("buildSubtitlePlaylist", () => {
  test("carries the whole track as one WebVTT segment", () => {
    const playlist = HLS.parse(buildSubtitlePlaylist(1, 12.021, "?token=t"));
    if (playlist.isMasterPlaylist) {
      throw new Error("Expected a media playlist.");
    }
    expect(playlist.targetDuration).toBe(13);
    expect(playlist.playlistType).toBe("VOD");
    expect(playlist.endlist).toBe(true);
    expect(
      playlist.segments.map((segment) => [segment.uri, segment.duration]),
    ).toEqual([["subs-1.vtt?token=t", 12.021]]);
  });
});

describe("buildMediaPlaylist", () => {
  test("describes one segment per boundary pair", () => {
    const boundaries = [0, 3, 6, 9, 12.021];
    const playlist = HLS.parse(buildMediaPlaylist(boundaries, "?token=t"));
    if (playlist.isMasterPlaylist) {
      throw new Error("Expected a media playlist.");
    }
    expect(playlist.endlist).toBe(true);
    expect(playlist.playlistType).toBe("VOD");
    expect(playlist.version).toBe(7);
    expect(playlist.segments.length).toBe(boundaries.length - 1);
    playlist.segments.forEach((segment, index) => {
      expect(segment.uri).toBe(`${index}.m4s?token=t`);
      expect(segment.map.uri).toBe("init.mp4?token=t");
      const duration = (boundaries[index + 1] ?? 0) - (boundaries[index] ?? 0);
      expect(segment.duration).toBeCloseTo(duration, 6);
      expect(playlist.targetDuration).toBeGreaterThanOrEqual(
        Math.round(duration),
      );
    });
  });

  test("builds a one segment playlist", () => {
    const playlist = HLS.parse(buildMediaPlaylist([0, 5], ""));
    if (playlist.isMasterPlaylist) {
      throw new Error("Expected a media playlist.");
    }
    expect(playlist.segments.length).toBe(1);
    expect(playlist.segments[0]?.duration).toBeCloseTo(5, 6);
    expect(playlist.targetDuration).toBe(5);
  });

  test.each([[[0]], [[]]] as const)("rejects boundaries %o", (boundaries) => {
    expect(() => buildMediaPlaylist(boundaries, "")).toThrow(
      "A timeline needs at least two boundaries.",
    );
  });
});

describe("segmentCount", () => {
  test("is one less than the boundary count", () => {
    expect(segmentCount([0, 3, 6, 9, 12.021])).toBe(4);
    expect(segmentCount([0, 5])).toBe(1);
  });
});

describe("parseHlsName", () => {
  const known: [string, HlsName][] = [
    ["master.m3u8", { kind: "master" }],
    ["media.m3u8", { kind: "media" }],
    ["init.mp4", { kind: "init" }],
    ["0.m4s", { kind: "segment", index: 0 }],
    ["12.m4s", { kind: "segment", index: 12 }],
    ["subs-0.m3u8", { kind: "subtitles", index: 0 }],
    ["subs-3.vtt", { kind: "subtitle", index: 3 }],
  ];
  test.each(known)("%s -> %o", (name, expected) => {
    expect(parseHlsName(name)).toEqual(expected);
  });

  test.each([
    "../x",
    "01.m4s",
    "00.m4s",
    "x.m4s",
    "1.mp4",
    "",
    "init.MP4",
    "subs-01.vtt",
    "subs-1.srt",
    "subs-.m3u8",
  ])("rejects %s", (name) => {
    expect(parseHlsName(name)).toBeNull();
  });
});

describe("codecString", () => {
  const cases: [
    { codec: string; profile: string | null; level: number | null },
    string | null,
  ][] = [
    [{ codec: "h264", profile: "high", level: 40 }, "avc1.640028"],
    [
      { codec: "h264", profile: "constrainedbaseline", level: 31 },
      "avc1.42E01F",
    ],
    [{ codec: "hevc", profile: "main10", level: 120 }, "hvc1.2.4.L120.B0"],
    [{ codec: "aac", profile: "lc", level: null }, "mp4a.40.2"],
    [{ codec: "aac", profile: "heaac", level: null }, "mp4a.40.5"],
    [{ codec: "aac", profile: "heaacv2", level: null }, "mp4a.40.29"],
    [{ codec: "aac", profile: null, level: null }, "mp4a.40.2"],
    [{ codec: "aac", profile: "main", level: null }, null],
    [{ codec: "opus", profile: null, level: null }, "Opus"],
    [{ codec: "flac", profile: null, level: null }, "fLaC"],
    [{ codec: "h264", profile: "high", level: null }, null],
    [{ codec: "vp9", profile: null, level: null }, null],
  ];
  test.each(cases)("%o -> %p", (stream, expected) => {
    expect(codecString(stream)).toBe(expected);
  });
});

describe("variantCodecs", () => {
  const h264 = { codec: "h264", profile: "high", level: 40 };

  test("lists video and audio when both are known", () => {
    expect(variantCodecs(h264, { codec: "aac", profile: "lc" })).toEqual([
      "avc1.640028",
      "mp4a.40.2",
    ]);
  });

  test("advertises the aac profile the stream carries", () => {
    expect(variantCodecs(h264, { codec: "aac", profile: "heaac" })).toEqual([
      "avc1.640028",
      "mp4a.40.5",
    ]);
    expect(variantCodecs(h264, { codec: "aac", profile: "heaacv2" })).toEqual([
      "avc1.640028",
      "mp4a.40.29",
    ]);
  });

  test("returns empty when the video codec is unknown", () => {
    expect(
      variantCodecs(
        { codec: "vp9", profile: null, level: null },
        {
          codec: "aac",
          profile: "lc",
        },
      ),
    ).toEqual([]);
  });

  test("returns empty when the audio codec is unknown", () => {
    expect(variantCodecs(h264, { codec: "dts-hd", profile: null })).toEqual([]);
  });

  test("returns empty when the aac profile is unknown", () => {
    expect(variantCodecs(h264, { codec: "aac", profile: "main" })).toEqual([]);
  });

  test("lists only the video when there is no audio", () => {
    expect(variantCodecs(h264, undefined)).toEqual(["avc1.640028"]);
  });
});
