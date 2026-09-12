import { describe, expect, test } from "bun:test";
import {
  type PlaybackVersion,
  type SegmentTimeline,
  selectAdaptiveGroup,
} from "./adaptive.ts";
import type { VideoStream } from "./decisions.ts";
import type { ClientProfile, PlaybackCaps } from "./policy.ts";

const timeline: SegmentTimeline = {
  id: "cut-a",
  itemId: "item-a",
  boundariesSeconds: [0, 4, 8, 12],
};

const client: ClientProfile = {
  containers: ["mp4"],
  videoCodecs: [
    {
      codec: "hevc",
      profiles: ["main"],
      maxLevel: 153,
      maxWidth: 3840,
      maxHeight: 2160,
    },
    {
      codec: "h264",
      profiles: ["high"],
      maxLevel: 41,
      maxWidth: 1920,
      maxHeight: 1080,
    },
  ],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr", "hdr10"],
};

const wan6m: PlaybackCaps = { sessionRequest: 6_000_000, isLan: false };

const baseVideo: VideoStream = {
  codec: "h264",
  profile: "high",
  level: 41,
  width: 1920,
  height: 1080,
  bitrate: 3_000_000,
  hdr: "sdr",
};

function imported(
  id: string,
  video: Partial<VideoStream> = {},
  keyframesSeconds: readonly number[] = [0, 2, 4, 6, 8, 10],
): PlaybackVersion {
  return {
    id,
    itemId: "item-a",
    segmentTimelineId: "cut-a",
    durationSeconds: 12,
    video: { ...baseVideo, ...video },
    origin: "imported",
    keyframesSeconds,
  };
}

function stored(
  id: string,
  video: Partial<VideoStream> = {},
  complete = true,
  timelineAligned = true,
): PlaybackVersion {
  return {
    id,
    itemId: "item-a",
    segmentTimelineId: "cut-a",
    durationSeconds: 12,
    video: { ...baseVideo, ...video },
    origin: "stored",
    complete,
    timelineAligned,
  };
}

describe("selectAdaptiveGroup", () => {
  test("prefers the client's first codec family", () => {
    const hevc = imported("v-hevc", {
      codec: "hevc",
      profile: "main",
      level: 153,
      width: 3840,
      height: 2160,
      bitrate: 5_000_000,
    });
    const h264 = imported("v-h264");
    const result = selectAdaptiveGroup([h264, hevc], timeline, client, wan6m);
    expect(result.codec).toBe("hevc");
    expect(result.variants.map((v) => v.id)).toEqual(["v-hevc"]);
    expect(result.liveSource).toBeNull();
  });

  test("sorts variants by increasing bitrate", () => {
    const v3 = imported("v-3m");
    const v15 = imported("v-15m", { bitrate: 1_500_000 });
    const v6 = imported("v-6m", { bitrate: 6_000_000 });
    const result = selectAdaptiveGroup([v3, v15, v6], timeline, client, wan6m);
    expect(result.codec).toBe("h264");
    expect(result.variants.map((v) => v.id)).toEqual(["v-15m", "v-3m", "v-6m"]);
    expect(result.liveSource).toBeNull();
  });

  const unplayableHevc: [string, Partial<VideoStream>][] = [
    ["over the cap", { bitrate: 8_000_000 }],
    ["an incompatible profile", { profile: "main10" }],
  ];
  test.each(unplayableHevc)(
    "an existing h264 beats live encode when hevc is %s",
    (_label, video) => {
      const hevc = imported("v-hevc", {
        codec: "hevc",
        profile: "main",
        level: 153,
        width: 3840,
        height: 2160,
        bitrate: 5_000_000,
        ...video,
      });
      const h264 = stored("v-h264");
      const result = selectAdaptiveGroup([hevc, h264], timeline, client, wan6m);
      expect(result.codec).toBe("h264");
      expect(result.variants.map((v) => v.id)).toEqual(["v-h264"]);
      expect(result.liveSource).toBeNull();
    },
  );

  test("excludes a codec the client does not support", () => {
    const vp9 = imported("v-vp9", { codec: "vp9" });
    const h264 = imported("v-h264");
    const result = selectAdaptiveGroup([vp9, h264], timeline, client, wan6m);
    expect(result.codec).toBe("h264");
    expect(result.variants.map((v) => v.id)).toEqual(["v-h264"]);
  });

  const excluded: [string, PlaybackVersion][] = [
    ["another item", { ...imported("v-item"), itemId: "item-b" }],
    [
      "another cut with identical timestamps",
      { ...imported("v-cut"), segmentTimelineId: "cut-b" },
    ],
    ["no timeline", { ...imported("v-none"), segmentTimelineId: null }],
    ["a duration mismatch", { ...imported("v-duration"), durationSeconds: 13 }],
    [
      "unaligned imported keyframes",
      imported("v-unaligned", {}, [0, 2, 6, 8, 10]),
    ],
    ["an incomplete stored version", stored("v-incomplete", {}, false, true)],
    ["an unaligned stored version", stored("v-unaligned", {}, true, false)],
  ];
  test.each(excluded)("excludes %s from variants", (_label, version) => {
    const ok = imported("v-ok");
    const result = selectAdaptiveGroup([version, ok], timeline, client, wan6m);
    expect(result.codec).toBe("h264");
    expect(result.variants.map((v) => v.id)).toEqual(["v-ok"]);
    expect(result.liveSource).toBeNull();
  });

  const alignedKeys: [readonly number[]][] = [
    [[0, 4, 8]],
    [[0, 2, 4, 6, 8, 10]],
    [[0, 2, 4, 6, 8, 10, 12]],
  ];
  test.each(alignedKeys)(
    "accepts imported keyframes %o covering the timeline",
    (keyframesSeconds) => {
      const version = imported("v-imported", {}, keyframesSeconds);
      const result = selectAdaptiveGroup([version], timeline, client, wan6m);
      expect(result.codec).toBe("h264");
      expect(result.variants.map((v) => v.id)).toEqual(["v-imported"]);
      expect(result.liveSource).toBeNull();
    },
  );

  test("accepts a complete aligned stored version without keyframes", () => {
    const version = stored("v-stored");
    const result = selectAdaptiveGroup([version], timeline, client, wan6m);
    expect(result.codec).toBe("h264");
    expect(result.variants.map((v) => v.id)).toEqual(["v-stored"]);
    expect(result.liveSource).toBeNull();
  });

  test("the lowest policy cap filters variants", () => {
    const v3 = imported("v-3m");
    const v6 = imported("v-6m", { bitrate: 6_000_000 });
    const result = selectAdaptiveGroup([v3, v6], timeline, client, {
      globalDefault: 10_000_000,
      userOverride: 3_000_000,
      sessionRequest: 6_000_000,
      isLan: false,
    });
    expect(result.codec).toBe("h264");
    expect(result.variants.map((v) => v.id)).toEqual(["v-3m"]);
  });

  test("lan bypasses the policy cap", () => {
    const v3 = imported("v-3m");
    const v6 = imported("v-6m", { bitrate: 6_000_000 });
    const result = selectAdaptiveGroup([v3, v6], timeline, client, {
      sessionRequest: 3_000_000,
      isLan: true,
    });
    expect(result.variants.map((v) => v.id)).toEqual(["v-3m", "v-6m"]);
  });

  test("the client decoder limit still filters on lan", () => {
    const limited: ClientProfile = { ...client, maxBitrate: 3_000_000 };
    const v3 = imported("v-3m");
    const v6 = imported("v-6m", { bitrate: 6_000_000 });
    const result = selectAdaptiveGroup([v3, v6], timeline, limited, {
      isLan: true,
    });
    expect(result.variants.map((v) => v.id)).toEqual(["v-3m"]);
  });

  const liveSources: [string, PlaybackVersion][] = [
    ["an unaligned imported source", imported("v-un", {}, [0, 2, 6, 8, 10])],
    ["an unsupported codec", imported("v-vp9", { codec: "vp9" })],
    [
      "a complete stored source that cannot pass",
      stored("v-stored", { bitrate: 20_000_000 }, true, true),
    ],
  ];
  test.each(liveSources)(
    "%s alone becomes the live source",
    (_label, version) => {
      const result = selectAdaptiveGroup([version], timeline, client, wan6m);
      expect(result.codec).toBeNull();
      expect(result.variants).toEqual([]);
      expect(result.liveSource?.id).toBe(version.id);
    },
  );

  test("prefers the highest bitrate source for live", () => {
    const v10 = imported("v-10m", { bitrate: 10_000_000 });
    const v20 = imported("v-20m", { bitrate: 20_000_000 });
    const result = selectAdaptiveGroup([v10, v20], timeline, client, wan6m);
    expect(result.codec).toBeNull();
    expect(result.variants).toEqual([]);
    expect(result.liveSource?.id).toBe("v-20m");
  });

  const noLive: [string, PlaybackVersion][] = [
    ["an incomplete stored version", stored("v-incomplete", {}, false, true)],
    ["a different cut", { ...imported("v-cut"), segmentTimelineId: "cut-b" }],
  ];
  test.each(noLive)("%s alone yields no live source", (_label, version) => {
    const result = selectAdaptiveGroup([version], timeline, client, wan6m);
    expect(result).toEqual({ codec: null, variants: [], liveSource: null });
  });

  test("no versions yields no live source", () => {
    expect(selectAdaptiveGroup([], timeline, client, wan6m)).toEqual({
      codec: null,
      variants: [],
      liveSource: null,
    });
  });

  test("duplicate client codec entries do not duplicate variants", () => {
    const duplicated: ClientProfile = {
      ...client,
      videoCodecs: [
        {
          codec: "h264",
          profiles: ["high"],
          maxLevel: 41,
          maxWidth: 1920,
          maxHeight: 1080,
        },
        { codec: "h264", profiles: ["main"], maxLevel: 40 },
        { codec: "hevc", profiles: ["main"], maxLevel: 153 },
      ],
    };
    const a = imported("v-a");
    const b = imported("v-b", { bitrate: 2_000_000 });
    const result = selectAdaptiveGroup([a, b], timeline, duplicated, wan6m);
    expect(result.codec).toBe("h264");
    expect(result.variants.map((v) => v.id)).toEqual(["v-b", "v-a"]);
  });

  test("leaves the versions array unchanged", () => {
    const versions = [
      imported("v-3m"),
      stored("v-6m", { bitrate: 6_000_000 }),
      imported("v-15m", { bitrate: 1_500_000 }),
    ];
    const snapshot = structuredClone(versions);
    const result = selectAdaptiveGroup(versions, timeline, client, wan6m);
    expect(result.variants.map((v) => v.id)).toEqual(["v-15m", "v-3m", "v-6m"]);
    expect(versions).toEqual(snapshot);
  });
});
