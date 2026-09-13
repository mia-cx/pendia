import { describe, expect, test } from "bun:test";
import * as HLS from "hls-parser";
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  codecString,
  segmentCount,
} from "./playlists.ts";

HLS.setOptions({ strictMode: true });

describe("buildMasterPlaylist", () => {
  test("advertises one variant carrying the query", () => {
    const playlist = HLS.parse(
      buildMasterPlaylist(
        {
          bandwidth: 5_000_000,
          width: 1920,
          height: 1080,
          codecs: ["avc1.640028", "mp4a.40.2"],
        },
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
        { bandwidth: 5_000_000, width: 1920, height: 1080, codecs: [] },
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
    [{ codec: "h264", profile: "high", level: null }, null],
    [{ codec: "vp9", profile: null, level: null }, null],
  ];
  test.each(cases)("%o -> %p", (stream, expected) => {
    expect(codecString(stream)).toBe(expected);
  });
});
