import { describe, expect, test } from "bun:test";
import {
  type AudioStream,
  decidePlayback,
  type PlaybackSource,
  requiresBurnIn,
  type SubtitleDecision,
  type SubtitleStream,
  type VideoStream,
  videoPasses,
} from "./decisions.ts";
import {
  type CapabilityTable,
  type ClientProfile,
  cpuCapabilities,
} from "./policy.ts";

const client: ClientProfile = {
  containers: ["mp4"],
  videoCodecs: [
    {
      codec: "hevc",
      profiles: ["main", "main10"],
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
  audioCodecs: [
    { codec: "aac", maxChannels: 2 },
    { codec: "eac3", maxChannels: 6 },
  ],
  subtitleFormats: ["srt", "pgs", "vobsub"],
  hdr: ["sdr", "hdr10"],
};

const source: PlaybackSource = {
  container: "mp4",
  video: {
    codec: "h264",
    profile: "high",
    level: 41,
    width: 1920,
    height: 1080,
    bitrate: 6_000_000,
    hdr: "sdr",
  },
  audio: [{ codec: "aac", channels: 2 }],
  subtitles: [{ format: "srt", kind: "text" }],
};

const dvVideo: VideoStream = {
  ...source.video,
  codec: "hevc",
  profile: "main10",
  level: 153,
  hdr: "dolby-vision",
};

const losslessClient: ClientProfile = {
  ...client,
  audioCodecs: [
    { codec: "aac", maxChannels: 2 },
    { codec: "eac3", maxChannels: 6 },
    { codec: "truehd", maxChannels: 8 },
    { codec: "dts-hd", maxChannels: 8 },
  ],
};

type PlayResult = ReturnType<typeof decidePlayback>;
type VideoTranscode = Extract<PlayResult["video"], { action: "transcode" }>;
type AudioDecision = NonNullable<PlayResult["audio"]>;

const hevcFull: VideoTranscode = {
  action: "transcode",
  codec: "hevc",
  profile: "main",
  level: 153,
  maxFrameRate: 257,
  width: 1920,
  height: 1080,
  bitrate: 20_000_000,
  rung: { bitrate: 20_000_000, width: 3840, height: 2160 },
  hdr: "sdr",
  toneMap: null,
  backend: "cpu",
  burnSubtitles: false,
};

const failingVideos: [Partial<VideoStream>, number | null][] = [
  [{ codec: "vp9" }, null],
  [{ profile: "baseline" }, null],
  [{ profile: null }, null],
  [{ level: 42 }, null],
  [{ level: null }, null],
  [{ width: 3840 }, null],
  [{ height: 2160 }, null],
  [{ bitrate: 6_000_001 }, 6_000_000],
  [{ hdr: "hlg" }, null],
];

describe("videoPasses", () => {
  test.each([null, 6_000_000])(
    "accepts the boundary video at cap %i",
    (cap) => {
      expect(videoPasses(source.video, client, cap)).toBe(true);
    },
  );

  test("accepts a null profile and level without constraints", () => {
    const open: ClientProfile = {
      ...client,
      videoCodecs: [{ codec: "h264" }],
    };
    expect(
      videoPasses({ ...source.video, profile: null, level: null }, open, null),
    ).toBe(true);
  });

  test.each(failingVideos)("rejects %o at cap %i", (overrides, cap) => {
    expect(videoPasses({ ...source.video, ...overrides }, client, cap)).toBe(
      false,
    );
  });
});

describe("decidePlayback methods", () => {
  test("direct plays a fully compatible source", () => {
    expect(decidePlayback(source, client, { isLan: false })).toEqual({
      method: "direct-play",
      video: {
        action: "copy",
        codec: "h264",
        hdr: "sdr",
        stripDolbyVision: false,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
      subtitles: [{ stream: 0, action: "copy", format: "srt" }],
      selection: { audio: 0 },
    });
  });

  test("remuxes a rejected container without re-encoding", () => {
    const result = decidePlayback({ ...source, container: "mkv" }, client, {
      isLan: false,
    });
    expect(result).toEqual({
      method: "remux",
      video: {
        action: "copy",
        codec: "h264",
        hdr: "sdr",
        stripDolbyVision: false,
      },
      audio: { action: "copy", codec: "aac", channels: 2 },
      subtitles: [
        { stream: 0, action: "convert", format: "webvtt", delivery: "sidecar" },
      ],
      selection: { audio: 0 },
    });
  });

  const hlsTextCases: [
    string,
    Partial<PlaybackSource>,
    PlayResult["method"],
  ][] = [
    ["srt", { container: "mkv" }, "remux"],
    ["ass", { audio: [{ codec: "dts", channels: 6 }] }, "transcode"],
    ["srt", { video: { ...source.video, codec: "vp9" } }, "transcode"],
  ];
  test.each(hlsTextCases)(
    "converts supported %s after HLS is required by %o",
    (format, overrides, method) => {
      const result = decidePlayback(
        { ...source, ...overrides, subtitles: [{ format, kind: "text" }] },
        { ...client, subtitleFormats: [format] },
        { isLan: false },
      );
      expect(result.method).toBe(method);
      expect(result.subtitles).toEqual([
        { stream: 0, action: "convert", format: "webvtt", delivery: "sidecar" },
      ]);
    },
  );

  test("copies supported WebVTT when HLS is required", () => {
    const result = decidePlayback(
      {
        ...source,
        container: "mkv",
        subtitles: [{ format: "webvtt", kind: "text" }],
      },
      { ...client, subtitleFormats: ["webvtt"] },
      { isLan: false },
    );
    expect(result.method).toBe("remux");
    expect(result.subtitles).toEqual([
      { stream: 0, action: "copy", format: "webvtt" },
    ]);
  });

  const textSubtitles: [
    SubtitleStream,
    readonly string[],
    SubtitleDecision,
    PlayResult["method"],
  ][] = [
    [
      { format: "srt", kind: "text" },
      ["srt"],
      { action: "copy", format: "srt" },
      "direct-play",
    ],
    [
      { format: "ass", kind: "text" },
      ["srt"],
      { action: "convert", format: "webvtt", delivery: "sidecar" },
      "remux",
    ],
    [
      { format: "webvtt", kind: "text" },
      ["srt"],
      { action: "convert", format: "webvtt", delivery: "sidecar" },
      "remux",
    ],
    [
      { format: "webvtt", kind: "text" },
      ["webvtt"],
      { action: "copy", format: "webvtt" },
      "direct-play",
    ],
  ];
  test.each(textSubtitles)(
    "text subtitle %s copies or converts, never burns",
    (subtitle, formats, expected, method) => {
      const c: ClientProfile = { ...client, subtitleFormats: formats };
      const result = decidePlayback({ ...source, subtitles: [subtitle] }, c, {
        isLan: false,
      });
      expect(result.subtitles).toEqual([{ stream: 0, ...expected }]);
      expect(result.method).toBe(method);
      expect(result.video.action).toBe("copy");
    },
  );

  const bitmapSubtitles: [SubtitleStream, SubtitleDecision][] = [
    [
      { format: "pgs", kind: "bitmap" },
      { action: "copy", format: "pgs" },
    ],
    [
      { format: "vobsub", kind: "bitmap" },
      { action: "copy", format: "vobsub" },
    ],
  ];
  test.each(bitmapSubtitles)(
    "supported bitmap %s copies on direct play",
    (subtitle, expected) => {
      const result = decidePlayback(
        { ...source, subtitles: [subtitle], selection: { subtitle: 0 } },
        client,
        { isLan: false },
      );
      expect(result.method).toBe("direct-play");
      expect(result.subtitles).toEqual([{ stream: 0, ...expected }]);
    },
  );

  test.each(["pgs", "vobsub"])(
    "unsupported bitmap %s burns into a video transcode",
    (format) => {
      const textOnly: ClientProfile = { ...client, subtitleFormats: ["srt"] };
      const result = decidePlayback(
        {
          ...source,
          subtitles: [{ format, kind: "bitmap" }],
          selection: { subtitle: 0 },
        },
        textOnly,
        { isLan: false },
      );
      expect(result.method).toBe("transcode");
      expect(result.subtitles).toEqual([{ stream: 0, action: "burn", format }]);
      expect(result.video).toEqual({ ...hevcFull, burnSubtitles: true });
    },
  );

  test.each(failingVideos)("transcodes video %o", (overrides, cap) => {
    const result = decidePlayback(
      { ...source, video: { ...source.video, ...overrides } },
      client,
      { sessionRequest: cap, isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.video.action).toBe("transcode");
  });
});

describe("decidePlayback video", () => {
  test("transcodes an unsupported codec to the best client codec", () => {
    const result = decidePlayback(
      { ...source, video: { ...source.video, codec: "vp9" } },
      client,
      { isLan: false },
    );
    expect(result.video).toEqual(hevcFull);
  });

  test("skips a client codec no backend asserts", () => {
    const vp9First: ClientProfile = {
      ...client,
      videoCodecs: [
        { codec: "vp9" },
        {
          codec: "h264",
          profiles: ["high"],
          maxLevel: 41,
          maxWidth: 1920,
          maxHeight: 1080,
        },
      ],
    };
    const result = decidePlayback(
      { ...source, video: { ...source.video, codec: "hevc" } },
      vp9First,
      { isLan: false },
    );
    expect(result.video).toEqual({
      action: "transcode",
      codec: "h264",
      profile: "high",
      level: 41,
      maxFrameRate: 30,
      width: 1920,
      height: 1080,
      bitrate: 20_000_000,
      rung: { bitrate: 20_000_000, width: 3840, height: 2160 },
      hdr: "sdr",
      toneMap: null,
      backend: "cpu",
      burnSubtitles: false,
    });
  });

  test("skips a client codec with an empty profile list", () => {
    const emptyProfiles: ClientProfile = {
      ...client,
      videoCodecs: [
        { codec: "av1", profiles: [] },
        {
          codec: "h264",
          profiles: ["high"],
          maxLevel: 41,
          maxWidth: 1920,
          maxHeight: 1080,
        },
      ],
    };
    const result = decidePlayback(
      { ...source, video: { ...source.video, codec: "vp9" } },
      emptyProfiles,
      { isLan: false },
    );
    expect(result.video).toMatchObject({ codec: "h264", profile: "high" });
  });

  test("throws when no backend supports the required output", () => {
    const vp9Only: ClientProfile = {
      ...client,
      videoCodecs: [{ codec: "vp9" }],
    };
    expect(() => decidePlayback(source, vp9Only, { isLan: false })).toThrow(
      "No backend supports the required video output.",
    );
  });

  const hdrFlavors: ["hdr10" | "hdr10+" | "hlg", "hdr10" | "hdr10+" | "hlg"][] =
    [
      ["hdr10", "hdr10"],
      ["hdr10+", "hdr10+"],
      ["hlg", "hlg"],
    ];
  test.each(hdrFlavors)("unsupported %s tone maps to sdr", (hdr, toneMap) => {
    const sdrClient: ClientProfile = { ...client, hdr: ["sdr"] };
    const result = decidePlayback(
      { ...source, video: { ...source.video, hdr } },
      sdrClient,
      { isLan: false },
    );
    expect(result.video).toEqual({ ...hevcFull, toneMap });
  });

  test("supported hdr10 stays a copy", () => {
    const result = decidePlayback(
      { ...source, video: { ...source.video, hdr: "hdr10" } },
      client,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.video).toEqual({
      action: "copy",
      codec: "h264",
      hdr: "hdr10",
      stripDolbyVision: false,
    });
  });

  test.each([7, 8])(
    "dv profile %i remuxes its hdr10 base layer without dolby vision",
    (dvProfile) => {
      const result = decidePlayback(
        { ...source, video: { ...dvVideo, dvProfile } },
        client,
        { isLan: false },
      );
      expect(result.method).toBe("remux");
      expect(result.video).toEqual({
        action: "copy",
        codec: "hevc",
        hdr: "hdr10",
        stripDolbyVision: true,
      });
    },
  );

  test.each([7, 8])(
    "dv profile %i tone maps hdr10 on an sdr client",
    (dvProfile) => {
      const sdrClient: ClientProfile = { ...client, hdr: ["sdr"] };
      const result = decidePlayback(
        { ...source, video: { ...dvVideo, dvProfile } },
        sdrClient,
        { isLan: false },
      );
      expect(result.video).toEqual({ ...hevcFull, toneMap: "hdr10" });
    },
  );

  const hdrOutputCases: [
    string,
    ClientProfile["videoCodecs"],
    {
      codec: string;
      profile: string;
      hdr: "sdr" | "hdr10";
      toneMap: "hdr10" | null;
      backend: "cpu" | "qsv";
      width?: number;
      height?: number;
    },
  ][] = [
    [
      "preferred h264 high",
      [
        { codec: "h264", profiles: ["high"] },
        { codec: "hevc", profiles: ["main10"] },
      ],
      {
        codec: "h264",
        profile: "high",
        hdr: "sdr",
        toneMap: "hdr10",
        backend: "cpu",
      },
    ],
    [
      "hevc main only",
      [{ codec: "hevc", profiles: ["main"] }],
      {
        codec: "hevc",
        profile: "main",
        hdr: "sdr",
        toneMap: "hdr10",
        backend: "cpu",
      },
    ],
    [
      "hevc main before main10",
      [{ codec: "hevc", profiles: ["main", "main10"] }],
      {
        codec: "hevc",
        profile: "main10",
        hdr: "hdr10",
        toneMap: null,
        backend: "qsv",
      },
    ],
    [
      "split hevc profiles retain their dimension constraints",
      [
        { codec: "hevc", profiles: ["main"] },
        { codec: "hevc", profiles: ["main10"], maxWidth: 640, maxHeight: 360 },
      ],
      {
        codec: "hevc",
        profile: "main10",
        hdr: "hdr10",
        toneMap: null,
        backend: "qsv",
        width: 640,
        height: 360,
      },
    ],
    [
      "split hevc profiles spanning another codec",
      [
        { codec: "hevc", profiles: ["main"] },
        { codec: "h264", profiles: ["high"] },
        { codec: "hevc", profiles: ["main10"] },
      ],
      {
        codec: "hevc",
        profile: "main10",
        hdr: "hdr10",
        toneMap: null,
        backend: "qsv",
      },
    ],
    [
      "unconstrained hevc",
      [{ codec: "hevc" }],
      {
        codec: "hevc",
        profile: "main10",
        hdr: "hdr10",
        toneMap: null,
        backend: "qsv",
      },
    ],
    [
      "av1 main",
      [{ codec: "av1", profiles: ["main"] }],
      {
        codec: "av1",
        profile: "main",
        hdr: "hdr10",
        toneMap: null,
        backend: "qsv",
      },
    ],
  ];
  test.each(hdrOutputCases)(
    "selects an executable HDR output for %s",
    (_label, videoCodecs, expected) => {
      const result = decidePlayback(
        { ...source, video: { ...dvVideo, dvProfile: 8 } },
        { ...client, videoCodecs, hdr: ["sdr", "hdr10", "dolby-vision"] },
        { isLan: false, sessionRequest: 3_000_000 },
        {
          qsv: { codecs: ["h264", "hevc", "av1"], toneMapping: [] },
          cpu: cpuCapabilities.cpu,
        },
      );
      expect(result.method).toBe("transcode");
      expect(result.video).toMatchObject({
        action: "transcode",
        ...expected,
      });
    },
  );

  test.each([
    ["av1", "high"],
    ["h264", "high10"],
  ])("preserves HDR with accepted %s profile %s", (codec, profile) => {
    const result = decidePlayback(
      { ...source, video: { ...dvVideo, dvProfile: 8 } },
      {
        ...client,
        videoCodecs: [{ codec, profiles: [profile] }],
        hdr: ["sdr", "hdr10", "dolby-vision"],
      },
      { isLan: false, sessionRequest: 3_000_000 },
    );
    expect(result.video).toMatchObject({
      action: "transcode",
      codec,
      profile,
      hdr: "hdr10",
      toneMap: null,
      backend: "cpu",
    });
  });

  const dvBaseLayerCases: [
    number,
    ClientProfile["hdr"],
    "hdr10" | "sdr",
    "hdr10" | null,
  ][] = [
    [7, ["sdr", "dolby-vision", "hdr10"], "hdr10", null],
    [8, ["sdr", "dolby-vision", "hdr10"], "hdr10", null],
    [7, ["sdr", "dolby-vision"], "sdr", "hdr10"],
    [8, ["sdr", "dolby-vision"], "sdr", "hdr10"],
  ];
  test.each(dvBaseLayerCases)(
    "dv profile %i re-encodes its base layer for client HDR %o",
    (dvProfile, supportedHdr, hdr, toneMap) => {
      const dvClient: ClientProfile = {
        ...client,
        hdr: supportedHdr,
        videoCodecs: [{ codec: "hevc", profiles: ["main10"] }],
      };
      const input: PlaybackSource = {
        ...source,
        video: { ...dvVideo, dvProfile },
      };
      expect(decidePlayback(input, dvClient, { isLan: false }).video).toEqual({
        action: "copy",
        codec: "hevc",
        hdr: "dolby-vision",
        stripDolbyVision: false,
      });
      const result = decidePlayback(
        input,
        dvClient,
        { isLan: false, sessionRequest: 3_000_000 },
        {
          qsv: { codecs: ["hevc"], toneMapping: ["hdr10"] },
          cpu: cpuCapabilities.cpu,
        },
      );
      expect(result.method).toBe("transcode");
      expect(result.video).toMatchObject({
        action: "transcode",
        codec: "hevc",
        hdr,
        toneMap,
        backend: "qsv",
      });
    },
  );

  test("dv profile 5 forces the cpu tone map even when hardware claims it", () => {
    const table: CapabilityTable = {
      qsv: { codecs: ["hevc", "h264"], toneMapping: ["dolby-vision"] },
      vaapi: { codecs: ["hevc"], toneMapping: ["dolby-vision"] },
      cpu: cpuCapabilities.cpu,
    };
    const sdrClient: ClientProfile = { ...client, hdr: ["sdr"] };
    const result = decidePlayback(
      {
        ...source,
        video: { ...dvVideo, dvProfile: 5 },
      },
      sdrClient,
      { isLan: false },
      table,
    );
    expect(result.video).toEqual({
      ...hevcFull,
      toneMap: "dolby-vision",
      backend: "cpu",
    });
  });

  test.each(["bitrate", "resolution", "subtitle"] as const)(
    "dv profile 5 uses the cpu tone map when %s forces re-encoding on a dv client",
    (trigger) => {
      const dvClient: ClientProfile = {
        ...client,
        hdr: ["sdr", "dolby-vision"],
        subtitleFormats: ["srt"],
        videoCodecs: [
          {
            codec: "hevc",
            profiles: ["main10"],
            maxLevel: 153,
            maxWidth: trigger === "resolution" ? 1280 : 3840,
            maxHeight: trigger === "resolution" ? 720 : 2160,
          },
        ],
      };
      const table: CapabilityTable = {
        qsv: { codecs: ["hevc"], toneMapping: ["dolby-vision"] },
        cpu: cpuCapabilities.cpu,
      };
      const result = decidePlayback(
        {
          ...source,
          video: { ...dvVideo, dvProfile: 5 },
          subtitles:
            trigger === "subtitle" ? [{ format: "pgs", kind: "bitmap" }] : [],
          selection: trigger === "subtitle" ? { subtitle: 0 } : undefined,
        },
        dvClient,
        {
          isLan: false,
          sessionRequest: trigger === "bitrate" ? 3_000_000 : null,
        },
        table,
      );
      expect(result.method).toBe("transcode");
      expect(result.video).toMatchObject({
        action: "transcode",
        hdr: "sdr",
        toneMap: "dolby-vision",
        backend: "cpu",
        burnSubtitles: trigger === "subtitle",
      });
    },
  );

  test.each([null, 9])(
    "tone maps a DV re-encode with profile %s instead of preserving metadata",
    (dvProfile) => {
      const result = decidePlayback(
        { ...source, video: { ...dvVideo, dvProfile } },
        {
          ...client,
          videoCodecs: [{ codec: "hevc", profiles: ["main10"] }],
          hdr: ["sdr", "dolby-vision"],
        },
        { isLan: false, sessionRequest: 3_000_000 },
        {
          qsv: { codecs: ["hevc"], toneMapping: [] },
          cpu: cpuCapabilities.cpu,
        },
      );
      expect(result.method).toBe("transcode");
      expect(result.video).toMatchObject({
        action: "transcode",
        hdr: "sdr",
        toneMap: "dolby-vision",
        backend: "cpu",
      });
    },
  );

  test("dv profile 5 copies when the client supports dolby vision", () => {
    const dvClient: ClientProfile = {
      ...client,
      hdr: ["sdr", "dolby-vision"],
    };
    const result = decidePlayback(
      {
        ...source,
        video: { ...dvVideo, dvProfile: 5 },
      },
      dvClient,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.video).toEqual({
      action: "copy",
      codec: "hevc",
      hdr: "dolby-vision",
      stripDolbyVision: false,
    });
  });

  const levelCandidates: [
    ClientProfile["videoCodecs"][number],
    ClientProfile["videoCodecs"][number],
  ][] = [
    [
      { codec: "h264", profiles: ["high"], maxLevel: 30 },
      { codec: "hevc", profiles: ["main10"], maxLevel: 153 },
    ],
    [
      { codec: "hevc", profiles: ["main"], maxLevel: 93 },
      { codec: "h264", profiles: ["high"], maxLevel: 41 },
    ],
    [
      { codec: "av1", profiles: ["main"], maxLevel: 8 },
      { codec: "hevc", profiles: ["main10"], maxLevel: 153 },
    ],
  ];
  test.each(levelCandidates)(
    "skips output exceeding level constraints %o",
    (limited, fallback) => {
      const result = decidePlayback(
        { ...source, video: { ...source.video, codec: "vp9" } },
        { ...client, videoCodecs: [limited, fallback] },
        { isLan: false },
      );
      expect(result.video).toMatchObject({
        action: "transcode",
        codec: fallback.codec,
        level: fallback.maxLevel,
      });
    },
  );

  test("rejects an output that cannot fit the sole client's level", () => {
    expect(() =>
      decidePlayback(
        source,
        {
          ...client,
          videoCodecs: [{ codec: "h264", profiles: ["high"], maxLevel: 30 }],
        },
        { isLan: false },
      ),
    ).toThrow("No backend supports the required video output.");
  });

  const frameRateCases: [
    ClientProfile["videoCodecs"][number],
    number,
    number,
  ][] = [
    [{ codec: "h264", profiles: ["high"], maxLevel: 41 }, 20_000_000, 30],
    [{ codec: "hevc", profiles: ["main"], maxLevel: 120 }, 10_000_000, 32],
    [{ codec: "av1", profiles: ["main"], maxLevel: 8 }, 10_000_000, 34],
  ];
  test.each(frameRateCases)(
    "caps output frame rate for %o",
    (candidate, sessionRequest, maxFrameRate) => {
      const result = decidePlayback(
        { ...source, video: { ...source.video, codec: "vp9" } },
        { ...client, videoCodecs: [candidate] },
        { isLan: false, sessionRequest },
      );
      expect(result.video).toMatchObject({ action: "transcode", maxFrameRate });
    },
  );
});

describe("decidePlayback audio", () => {
  const audioCases: [AudioStream, AudioDecision][] = [
    [
      { codec: "dts", channels: 6 },
      { action: "transcode", codec: "eac3", channels: 6 },
    ],
    [
      { codec: "dts", channels: 8 },
      { action: "transcode", codec: "eac3", channels: 6 },
    ],
    [
      { codec: "dts", channels: 4 },
      { action: "transcode", codec: "aac", channels: 2 },
    ],
    [
      { codec: "vorbis", channels: 2 },
      { action: "transcode", codec: "aac", channels: 2 },
    ],
  ];
  test.each(audioCases)(
    "unsupported %o follows the audio rule",
    (audio, expected) => {
      const result = decidePlayback({ ...source, audio: [audio] }, client, {
        isLan: false,
      });
      expect(result.method).toBe("transcode");
      expect(result.audio).toEqual(expected);
    },
  );

  test("falls to aac when eac3 channels fall short", () => {
    const narrow: ClientProfile = {
      ...client,
      audioCodecs: [
        { codec: "aac", maxChannels: 2 },
        { codec: "eac3", maxChannels: 2 },
      ],
    };
    const result = decidePlayback(
      { ...source, audio: [{ codec: "dts", channels: 6 }] },
      narrow,
      { isLan: false },
    );
    expect(result.audio).toEqual({
      action: "transcode",
      codec: "aac",
      channels: 2,
    });
  });

  test("downmixes excessive aac on a stereo client", () => {
    const stereo: ClientProfile = {
      ...client,
      audioCodecs: [{ codec: "aac", maxChannels: 2 }],
    };
    const result = decidePlayback(
      { ...source, audio: [{ codec: "aac", channels: 6 }] },
      stereo,
      { isLan: false },
    );
    expect(result.audio).toEqual({
      action: "transcode",
      codec: "aac",
      channels: 2,
    });
  });

  test("copies an accepted multichannel codec", () => {
    const result = decidePlayback(
      { ...source, audio: [{ codec: "eac3", channels: 6 }] },
      client,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.audio).toEqual({
      action: "copy",
      codec: "eac3",
      channels: 6,
    });
  });

  test.each(["truehd", "dts-hd"])("%s copies on direct play", (codec) => {
    const result = decidePlayback(
      { ...source, audio: [{ codec, channels: 8 }] },
      losslessClient,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.audio).toEqual({ action: "copy", codec, channels: 8 });
  });

  test.each(["truehd", "dts-hd"])("%s transcodes to eac3 over hls", (codec) => {
    const result = decidePlayback(
      { ...source, container: "mkv", audio: [{ codec, channels: 8 }] },
      losslessClient,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.audio).toEqual({
      action: "transcode",
      codec: "eac3",
      channels: 6,
    });
  });

  test.each(["truehd", "dts-hd"])(
    "%s falls to aac over hls without eac3",
    (codec) => {
      const noEac3: ClientProfile = {
        ...losslessClient,
        audioCodecs: [
          { codec: "aac", maxChannels: 2 },
          { codec, maxChannels: 8 },
        ],
      };
      const result = decidePlayback(
        { ...source, container: "mkv", audio: [{ codec, channels: 8 }] },
        noEac3,
        { isLan: false },
      );
      expect(result.audio).toEqual({
        action: "transcode",
        codec: "aac",
        channels: 2,
      });
    },
  );

  test("vorbis transcodes to aac over hls even when the client accepts it", () => {
    const vorbisClient: ClientProfile = {
      ...client,
      audioCodecs: [
        { codec: "aac", maxChannels: 2 },
        { codec: "vorbis", maxChannels: 2 },
      ],
    };
    const result = decidePlayback(
      {
        ...source,
        container: "mkv",
        audio: [{ codec: "vorbis", channels: 2 }],
      },
      vorbisClient,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.audio).toEqual({
      action: "transcode",
      codec: "aac",
      channels: 2,
    });
  });

  test("vorbis copies on direct play", () => {
    const vorbisClient: ClientProfile = {
      ...client,
      audioCodecs: [
        { codec: "aac", maxChannels: 2 },
        { codec: "vorbis", maxChannels: 2 },
      ],
    };
    const result = decidePlayback(
      { ...source, audio: [{ codec: "vorbis", channels: 2 }] },
      vorbisClient,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.audio).toEqual({
      action: "copy",
      codec: "vorbis",
      channels: 2,
    });
  });

  const vp8Video: VideoStream = {
    ...source.video,
    codec: "vp8",
    profile: null,
    level: null,
  };
  const vp8Client: ClientProfile = {
    ...client,
    videoCodecs: [
      { codec: "vp8" },
      {
        codec: "h264",
        profiles: ["high"],
        maxLevel: 41,
        maxWidth: 1920,
        maxHeight: 1080,
      },
    ],
  };

  test("vp8 transcodes to h264 over hls even when the client accepts it", () => {
    const result = decidePlayback(
      { ...source, container: "mkv", video: vp8Video },
      vp8Client,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.video.action).toBe("transcode");
    expect(result.video.codec).toBe("h264");
  });

  test("vp8 copies on direct play", () => {
    const result = decidePlayback({ ...source, video: vp8Video }, vp8Client, {
      isLan: false,
    });
    expect(result.method).toBe("direct-play");
    expect(result.video.action).toBe("copy");
    expect(result.video.codec).toBe("vp8");
  });

  test.each(["truehd", "dts-hd"])(
    "dv stripping re-evaluates %s for hls",
    (codec) => {
      const result = decidePlayback(
        {
          ...source,
          video: { ...dvVideo, dvProfile: 8 },
          audio: [{ codec, channels: 8 }],
        },
        losslessClient,
        { isLan: false },
      );
      expect(result.method).toBe("transcode");
      expect(result.video).toEqual({
        action: "copy",
        codec: "hevc",
        hdr: "hdr10",
        stripDolbyVision: true,
      });
      expect(result.audio).toEqual({
        action: "transcode",
        codec: "eac3",
        channels: 6,
      });
    },
  );

  test("a converted subtitle re-evaluates lossless audio for hls", () => {
    const result = decidePlayback(
      {
        ...source,
        audio: [{ codec: "truehd", channels: 8 }],
        subtitles: [{ format: "ass", kind: "text" }],
      },
      losslessClient,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.audio).toEqual({
      action: "transcode",
      codec: "eac3",
      channels: 6,
    });
  });

  test("a video transcode re-evaluates lossless audio for hls", () => {
    const result = decidePlayback(
      {
        ...source,
        video: { ...source.video, codec: "vp9" },
        audio: [{ codec: "dts-hd", channels: 8 }],
      },
      losslessClient,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.audio).toEqual({
      action: "transcode",
      codec: "eac3",
      channels: 6,
    });
  });

  test("throws when the client lacks the aac stereo fallback", () => {
    const noAac: ClientProfile = {
      ...client,
      audioCodecs: [{ codec: "eac3", maxChannels: 6 }],
    };
    expect(() =>
      decidePlayback(
        { ...source, audio: [{ codec: "aac", channels: 2 }] },
        noAac,
        { isLan: false },
      ),
    ).toThrow("The client does not support AAC stereo fallback.");
  });
});

describe("decidePlayback stream selection", () => {
  const dubbed: PlaybackSource = {
    ...source,
    audio: [
      { codec: "aac", channels: 2 },
      { codec: "dts", channels: 6 },
    ],
  };

  test("decides the default-flagged audio Stream, else the first", () => {
    expect(decidePlayback(dubbed, client, { isLan: false }).selection).toEqual({
      audio: 0,
    });
    const flagged = decidePlayback(
      {
        ...dubbed,
        audio: [
          { codec: "aac", channels: 2 },
          { codec: "eac3", channels: 6, default: true },
        ],
      },
      client,
      { isLan: false },
    );
    expect(flagged.method).toBe("direct-play");
    expect(flagged.selection).toEqual({ audio: 1 });
    expect(flagged.audio).toEqual({
      action: "copy",
      codec: "eac3",
      channels: 6,
    });
  });

  test("an unselected audio Stream does not change the method", () => {
    const result = decidePlayback(dubbed, client, { isLan: false });
    expect(result.method).toBe("direct-play");
    expect(result.audio).toEqual({ action: "copy", codec: "aac", channels: 2 });
  });

  test("a chosen audio Stream other than the default plays over HLS", () => {
    const result = decidePlayback(
      {
        ...dubbed,
        audio: [
          { codec: "aac", channels: 2 },
          { codec: "aac", channels: 2 },
        ],
        selection: { audio: 1 },
      },
      client,
      { isLan: false },
    );
    expect(result.method).toBe("remux");
    expect(result.selection).toEqual({ audio: 1 });
  });

  test("a chosen audio Stream is decided on its own", () => {
    const result = decidePlayback(
      { ...dubbed, selection: { audio: 1 } },
      client,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.audio).toEqual({
      action: "transcode",
      codec: "eac3",
      channels: 6,
    });
  });

  const signs: PlaybackSource = {
    ...source,
    subtitles: [
      { format: "srt", kind: "text" },
      { format: "pgs", kind: "bitmap" },
    ],
  };
  const textOnly: ClientProfile = { ...client, subtitleFormats: ["srt"] };

  test("subtitles off neither burns nor lists a subtitle", () => {
    const result = decidePlayback(
      { ...signs, selection: { subtitle: null } },
      textOnly,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.subtitles).toEqual([]);
    expect(result.selection).toEqual({ audio: 0, subtitle: null });
    expect(
      requiresBurnIn(
        { ...signs, selection: { subtitle: null } },
        textOnly,
        true,
      ),
    ).toBe(false);
  });

  test("a chosen text subtitle leaves an unselected bitmap one unburned", () => {
    const result = decidePlayback(
      { ...signs, selection: { subtitle: 0 } },
      textOnly,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.subtitles).toEqual([
      { stream: 0, action: "copy", format: "srt" },
    ]);
  });

  test("a chosen bitmap subtitle the client cannot draw burns", () => {
    const result = decidePlayback(
      { ...signs, selection: { subtitle: 1 } },
      textOnly,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.video).toMatchObject({ burnSubtitles: true });
    expect(result.subtitles).toEqual([
      { stream: 1, action: "burn", format: "pgs" },
    ]);
  });

  test("a chosen bitmap subtitle the client draws burns once HLS is needed", () => {
    const dubbedSigns: PlaybackSource = {
      ...signs,
      container: "mkv",
      audio: [
        { codec: "aac", channels: 2 },
        { codec: "aac", channels: 2 },
      ],
    };
    const mkv: ClientProfile = { ...client, containers: ["mkv"] };
    const direct = decidePlayback(
      { ...dubbedSigns, selection: { audio: 0, subtitle: 1 } },
      mkv,
      { isLan: false },
    );
    expect(direct.method).toBe("direct-play");
    expect(direct.subtitles).toEqual([
      { stream: 1, action: "copy", format: "pgs" },
    ]);
    const chosen = { ...dubbedSigns, selection: { audio: 1, subtitle: 1 } };
    const hls = decidePlayback(chosen, mkv, { isLan: false });
    expect(hls.method).toBe("transcode");
    expect(hls.video).toMatchObject({ burnSubtitles: true });
    expect(hls.subtitles).toEqual([
      { stream: 1, action: "burn", format: "pgs" },
    ]);
    expect(requiresBurnIn(chosen, mkv, false)).toBe(false);
    expect(requiresBurnIn(chosen, mkv, true)).toBe(true);
    // An unchosen bitmap track does not affect either delivery method.
    expect(requiresBurnIn(dubbedSigns, mkv, true)).toBe(false);
  });

  test.each([undefined, { audio: 0 }])(
    "an unchosen PGS subtitle leaves compatible video as a copy with selection %o",
    (selection) => {
      const input: PlaybackSource = {
        ...source,
        subtitles: [{ format: "pgs", kind: "bitmap" }],
        selection,
      };
      const result = decidePlayback(input, textOnly, { isLan: false });
      expect(result.method).toBe("direct-play");
      expect(result.video.action).toBe("copy");
      expect(result.subtitles).toEqual([]);
      expect(requiresBurnIn(input, textOnly, false)).toBe(false);
      expect(requiresBurnIn(input, textOnly, true)).toBe(false);
    },
  );

  test("no subtitle choice keeps text sidecars with their original Stream positions", () => {
    const input: PlaybackSource = {
      ...source,
      container: "mkv",
      subtitles: [
        { format: "pgs", kind: "bitmap" },
        { format: "srt", kind: "text" },
        { format: "ass", kind: "text" },
      ],
    };
    const result = decidePlayback(input, textOnly, { isLan: false });
    expect(result.method).toBe("remux");
    expect(result.video.action).toBe("copy");
    expect(result.subtitles).toEqual([
      { stream: 1, action: "convert", format: "webvtt", delivery: "sidecar" },
      { stream: 2, action: "convert", format: "webvtt", delivery: "sidecar" },
    ]);
    expect(requiresBurnIn(input, textOnly, true)).toBe(false);
  });
});

describe("decidePlayback caps and scaling", () => {
  test("the client decoder limit applies on lan", () => {
    const limited: ClientProfile = { ...client, maxBitrate: 3_000_000 };
    const result = decidePlayback(source, limited, { isLan: true });
    expect(result.method).toBe("transcode");
    expect(result.video).toEqual({
      ...hevcFull,
      maxFrameRate: 580,
      width: 1280,
      height: 720,
      bitrate: 3_000_000,
      rung: { bitrate: 3_000_000, width: 1280, height: 720 },
    });
  });

  test("lan copies above the policy cap without a decoder limit", () => {
    const result = decidePlayback(source, client, {
      isLan: true,
      sessionRequest: 1_500_000,
    });
    expect(result.method).toBe("direct-play");
    expect(result.video.action).toBe("copy");
  });

  test("a wan 6 mbit cap selects the 6 mbit rung", () => {
    const result = decidePlayback(
      { ...source, video: { ...source.video, bitrate: 10_000_000 } },
      client,
      { sessionRequest: 6_000_000, isLan: false },
    );
    expect(result.video).toEqual({
      ...hevcFull,
      bitrate: 6_000_000,
      rung: { bitrate: 6_000_000, width: 1920, height: 1080 },
    });
  });

  test("a wan 5 mbit cap selects the 3 mbit rung", () => {
    const result = decidePlayback(
      { ...source, video: { ...source.video, bitrate: 10_000_000 } },
      client,
      { sessionRequest: 5_000_000, isLan: false },
    );
    expect(result.video).toEqual({
      ...hevcFull,
      maxFrameRate: 580,
      width: 1280,
      height: 720,
      bitrate: 3_000_000,
      rung: { bitrate: 3_000_000, width: 1280, height: 720 },
    });
  });

  test("throws when no ladder rung fits the cap", () => {
    expect(() =>
      decidePlayback(source, client, {
        sessionRequest: 1_499_999,
        isLan: false,
      }),
    ).toThrow("No ladder rung fits the bitrate cap.");
  });

  test("copies a fitting source below the ladder minimum", () => {
    const result = decidePlayback(
      { ...source, video: { ...source.video, bitrate: 1_000_000 } },
      client,
      { sessionRequest: 1_499_999, isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.video).toEqual({
      action: "copy",
      codec: "h264",
      hdr: "sdr",
      stripDolbyVision: false,
    });
  });

  test("preserves aspect ratio inside the rung", () => {
    const result = decidePlayback(
      { ...source, video: { ...source.video, width: 3840, height: 1600 } },
      client,
      { sessionRequest: 3_000_000, isLan: false },
    );
    expect(result.video).toEqual({
      ...hevcFull,
      maxFrameRate: 785,
      width: 1280,
      height: 532,
      bitrate: 3_000_000,
      rung: { bitrate: 3_000_000, width: 1280, height: 720 },
    });
  });

  test("never upscales a small source", () => {
    const result = decidePlayback(
      {
        ...source,
        video: { ...source.video, codec: "vp9", width: 640, height: 360 },
      },
      client,
      { isLan: false },
    );
    expect(result.video).toEqual({
      ...hevcFull,
      maxFrameRate: 2321,
      width: 640,
      height: 360,
    });
  });

  test("fits within the client dimensions", () => {
    const bounded: ClientProfile = {
      ...client,
      videoCodecs: [
        {
          codec: "hevc",
          profiles: ["main"],
          maxLevel: 153,
          maxWidth: 1280,
          maxHeight: 720,
        },
      ],
    };
    const result = decidePlayback(source, bounded, { isLan: false });
    expect(result.video).toEqual({
      ...hevcFull,
      maxFrameRate: 580,
      width: 1280,
      height: 720,
    });
  });
});

describe("decidePlayback robustness", () => {
  test("supports sources without audio or subtitles", () => {
    const result = decidePlayback(
      { ...source, audio: [], subtitles: [] },
      client,
      { isLan: false },
    );
    expect(result).toEqual({
      method: "direct-play",
      video: {
        action: "copy",
        codec: "h264",
        hdr: "sdr",
        stripDolbyVision: false,
      },
      audio: null,
      subtitles: [],
      selection: { audio: null },
    });
  });

  test("rejects a selection the source lacks", () => {
    expect(() =>
      decidePlayback({ ...source, selection: { audio: 1 } }, client, {
        isLan: false,
      }),
    ).toThrow(RangeError);
    expect(() =>
      decidePlayback({ ...source, selection: { subtitle: 1 } }, client, {
        isLan: false,
      }),
    ).toThrow(RangeError);
  });

  test("leaves input objects unchanged", () => {
    const input: PlaybackSource = {
      ...source,
      video: { ...source.video, codec: "vp9" },
      subtitles: [{ format: "ass", kind: "text" }],
    };
    const inputSnapshot = structuredClone(input);
    const clientSnapshot = structuredClone(client);
    decidePlayback(input, client, { sessionRequest: 3_000_000, isLan: false });
    expect(input).toEqual(inputSnapshot);
    expect(client).toEqual(clientSnapshot);
  });
});
