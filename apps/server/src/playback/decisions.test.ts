import { describe, expect, test } from "bun:test";
import {
  type AudioStream,
  decidePlayback,
  type PlaybackSource,
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
type AudioDecision = PlayResult["audio"][number];
type SubtitleDecision = PlayResult["subtitles"][number];

const hevcFull: VideoTranscode = {
  action: "transcode",
  codec: "hevc",
  profile: "main",
  level: 153,
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
      audio: [{ action: "copy", codec: "aac", channels: 2 }],
      subtitles: [{ action: "copy", format: "srt" }],
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
      audio: [{ action: "copy", codec: "aac", channels: 2 }],
      subtitles: [{ action: "copy", format: "srt" }],
    });
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
      expect(result.subtitles).toEqual([expected]);
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
        { ...source, subtitles: [subtitle] },
        client,
        { isLan: false },
      );
      expect(result.method).toBe("direct-play");
      expect(result.subtitles).toEqual([expected]);
    },
  );

  test.each(["pgs", "vobsub"])(
    "unsupported bitmap %s burns into a video transcode",
    (format) => {
      const textOnly: ClientProfile = { ...client, subtitleFormats: ["srt"] };
      const result = decidePlayback(
        { ...source, subtitles: [{ format, kind: "bitmap" }] },
        textOnly,
        { isLan: false },
      );
      expect(result.method).toBe("transcode");
      expect(result.subtitles).toEqual([{ action: "burn", format }]);
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
    "dv profile %i plays its hdr10 base layer without dolby vision",
    (dvProfile) => {
      const result = decidePlayback(
        {
          ...source,
          video: {
            ...source.video,
            hdr: "dolby-vision",
            dvProfile,
          },
        },
        client,
        { isLan: false },
      );
      expect(result.method).toBe("direct-play");
      expect(result.video).toEqual({
        action: "copy",
        codec: "h264",
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
        {
          ...source,
          video: {
            ...source.video,
            hdr: "dolby-vision",
            dvProfile,
          },
        },
        sdrClient,
        { isLan: false },
      );
      expect(result.video).toEqual({ ...hevcFull, toneMap: "hdr10" });
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
        video: { ...source.video, hdr: "dolby-vision", dvProfile: 5 },
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

  test("dv profile 5 copies when the client supports dolby vision", () => {
    const dvClient: ClientProfile = {
      ...client,
      hdr: ["sdr", "dolby-vision"],
    };
    const result = decidePlayback(
      {
        ...source,
        video: { ...source.video, hdr: "dolby-vision", dvProfile: 5 },
      },
      dvClient,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.video).toEqual({
      action: "copy",
      codec: "h264",
      hdr: "dolby-vision",
      stripDolbyVision: false,
    });
  });
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
      expect(result.audio).toEqual([expected]);
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
    expect(result.audio).toEqual([
      { action: "transcode", codec: "aac", channels: 2 },
    ]);
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
    expect(result.audio).toEqual([
      { action: "transcode", codec: "aac", channels: 2 },
    ]);
  });

  test("copies an accepted multichannel codec", () => {
    const result = decidePlayback(
      { ...source, audio: [{ codec: "eac3", channels: 6 }] },
      client,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.audio).toEqual([
      { action: "copy", codec: "eac3", channels: 6 },
    ]);
  });

  test.each(["truehd", "dts-hd"])("%s copies on direct play", (codec) => {
    const result = decidePlayback(
      { ...source, audio: [{ codec, channels: 8 }] },
      losslessClient,
      { isLan: false },
    );
    expect(result.method).toBe("direct-play");
    expect(result.audio).toEqual([{ action: "copy", codec, channels: 8 }]);
  });

  test.each(["truehd", "dts-hd"])("%s transcodes to eac3 over hls", (codec) => {
    const result = decidePlayback(
      { ...source, container: "mkv", audio: [{ codec, channels: 8 }] },
      losslessClient,
      { isLan: false },
    );
    expect(result.method).toBe("transcode");
    expect(result.audio).toEqual([
      { action: "transcode", codec: "eac3", channels: 6 },
    ]);
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
      expect(result.audio).toEqual([
        { action: "transcode", codec: "aac", channels: 2 },
      ]);
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
    expect(result.audio).toEqual([
      { action: "transcode", codec: "eac3", channels: 6 },
    ]);
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
    expect(result.audio).toEqual([
      { action: "transcode", codec: "eac3", channels: 6 },
    ]);
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

describe("decidePlayback caps and scaling", () => {
  test("the client decoder limit applies on lan", () => {
    const limited: ClientProfile = { ...client, maxBitrate: 3_000_000 };
    const result = decidePlayback(source, limited, { isLan: true });
    expect(result.method).toBe("transcode");
    expect(result.video).toEqual({
      ...hevcFull,
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
    expect(result.video).toEqual({ ...hevcFull, width: 640, height: 360 });
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
    expect(result.video).toEqual({ ...hevcFull, width: 1280, height: 720 });
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
      audio: [],
      subtitles: [],
    });
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
