import { describe, expect, test } from "bun:test";
import {
  audioNames,
  clientProfile,
  formatPosition,
  type MediaSupport,
  subtitleNames,
  withToken,
} from "./playback.ts";

// What Chromium 151 on Linux answers: no HEVC, no AC-3 and no QuickTime.
const decoded = [
  "avc1.42E01E",
  "avc1.42001E",
  "avc1.4D401F",
  "avc1.640028",
  "avc1.6E0028",
  "av01.0.08M.08",
  "vp09.00.10.08",
  "vp09.02.10.10",
  "mp4a.40.2",
  "opus",
  "flac",
];

const chromium: MediaSupport = {
  container: (mime) => mime !== "video/quicktime",
  codec: (mime) => decoded.some((type) => mime.includes(`"${type}"`)),
  hdr: false,
};

describe("client profile", () => {
  test("lists what the browser decodes and leaves out the rest", () => {
    const profile = clientProfile(chromium);
    expect(profile.containers).toEqual(["mp4", "webm", "mkv"]);
    expect(profile.videoCodecs).toEqual([
      {
        codec: "h264",
        profiles: ["constrainedbaseline", "baseline", "main", "high", "high10"],
      },
      { codec: "av1", profiles: ["main"] },
      { codec: "vp9", profiles: ["profile0", "profile2"] },
    ]);
    expect(profile.audioCodecs).toEqual([
      { codec: "aac", maxChannels: 8 },
      { codec: "opus", maxChannels: 8 },
      { codec: "flac", maxChannels: 8 },
    ]);
    expect(profile.subtitleFormats).toEqual(["webvtt"]);
    expect(profile.hdr).toEqual(["sdr"]);
  });

  test("adds HEVC, Dolby audio and HDR where the browser has them", () => {
    const profile = clientProfile({
      container: () => true,
      codec: (mime) =>
        chromium.codec(mime) ||
        ["hvc1.1.6.L120.90", "ac-3", "ec-3"].some((type) =>
          mime.includes(`"${type}"`),
        ),
      hdr: true,
    });
    expect(profile.containers).toContain("mov");
    expect(profile.videoCodecs).toContainEqual({
      codec: "hevc",
      profiles: ["main"],
    });
    expect(profile.audioCodecs).toContainEqual({
      codec: "eac3",
      maxChannels: 8,
    });
    expect(profile.hdr).toEqual(["sdr", "hdr10", "hlg"]);
  });
});

describe("playback helpers", () => {
  test("a refreshed token replaces the old one and keeps the path", () => {
    const page = "https://pendia.test/play/i";
    expect(
      withToken(
        "https://pendia.test/api/playback/s/i/hls/3.m4s?token=old",
        "new.sig",
        page,
      ),
    ).toBe("https://pendia.test/api/playback/s/i/hls/3.m4s?token=new.sig");
    // hls.js hands the master playlist over as the plan wrote it.
    expect(
      withToken("/api/playback/s/i/hls/master.m3u8?token=old", "new", page),
    ).toBe("https://pendia.test/api/playback/s/i/hls/master.m3u8?token=new");
  });

  test("Streams read by title, else language, and never repeat", () => {
    const audio = {
      index: 1,
      codec: "aac",
      title: null,
      language: "eng",
      channels: 2,
    };
    expect(
      audioNames([
        audio,
        { ...audio, language: "jpn", channels: 6 },
        { ...audio, language: "und", channels: 6 },
        { ...audio, title: "Commentary", channels: 3 },
        audio,
      ]),
    ).toEqual([
      "English · Stereo (1)",
      "Japanese · 5.1",
      "Audio 3 · 5.1",
      "Commentary",
      "English · Stereo (5)",
    ]);
    const subtitle = {
      index: 2,
      codec: "subrip",
      title: null,
      language: "nld",
    };
    expect(
      subtitleNames([
        { ...subtitle, forced: true },
        { ...subtitle, language: null, forced: false },
        {
          ...subtitle,
          title: "Signs",
          codec: "hdmv_pgs_subtitle",
          forced: false,
        },
      ]),
    ).toEqual(["Dutch · Forced", "Subtitles 2", "Signs"]);
  });

  test("positions read as minutes or hours", () => {
    expect(formatPosition(0)).toBe("0:00");
    expect(formatPosition(754.9)).toBe("12:34");
    expect(formatPosition(3723)).toBe("1:02:03");
  });
});
