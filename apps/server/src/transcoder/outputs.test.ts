import { describe, expect, test } from "bun:test";
import { decidePlayback, type PlaybackSource } from "../playback/decisions.ts";
import type { ClientProfile } from "../playback/policy.ts";
import { type SubtitleDetails, sessionOutputs } from "./outputs.ts";

const source: PlaybackSource = {
  container: "matroska",
  video: {
    codec: "hevc",
    profile: "main",
    level: 120,
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    hdr: "sdr",
  },
  audio: [{ codec: "ac3", channels: 6, bitrate: 448_000 }],
  subtitles: [
    { format: "srt", kind: "text" },
    { format: "pgs", kind: "bitmap" },
    { format: "ass", kind: "text" },
    { format: "webvtt", kind: "text" },
  ],
};

const details: SubtitleDetails[] = [
  { language: "nld", title: null, disposition: { forced: true } },
  { language: "eng", title: null, disposition: {} },
  { language: "eng", title: null, disposition: { default: true } },
  { language: null, title: null, disposition: {} },
];

// A browser without HEVC or AC-3 that renders only WebVTT.
const browser: ClientProfile = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", profiles: ["high"], maxLevel: 41 }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["webvtt"],
  hdr: ["sdr"],
};

describe("sessionOutputs", () => {
  test("a session without a decision copies video and first audio and offers its text tracks", () => {
    const outputs = sessionOutputs(null, source, details);
    expect(outputs.video).toEqual({
      action: "copy",
      codec: "hevc",
      hdr: "sdr",
      stripDolbyVision: false,
    });
    expect(outputs.audio).toBeUndefined();
    expect(outputs.burnSubtitle).toBeUndefined();
    expect(outputs.variant).toEqual({
      uri: "media.m3u8",
      bandwidth: 8_448_000,
      width: 1920,
      height: 1080,
      codecs: ["hvc1.1.6.L120.B0", "ac-3"],
    });
    expect(outputs.subtitles.map((subtitle) => subtitle.index)).toEqual([
      0, 2, 3,
    ]);
  });

  test("a transcode advertises the rung, the encoded audio and burns the bitmap track", () => {
    const selected: PlaybackSource = {
      ...source,
      selection: { subtitle: 1 },
    };
    const decision = decidePlayback(selected, browser, { isLan: true });
    expect(decision.method).toBe("transcode");
    const outputs = sessionOutputs(decision, selected, details);
    expect(outputs.video).toMatchObject({
      action: "transcode",
      codec: "h264",
      width: 1920,
      height: 1080,
      burnSubtitles: true,
    });
    expect(outputs.audio).toEqual({
      action: "transcode",
      codec: "aac",
      channels: 2,
    });
    expect(outputs.burnSubtitle).toBe(1);
    expect(outputs.variant).toEqual({
      uri: "media.m3u8",
      bandwidth: 20_000_000 + 192_000,
      width: 1920,
      height: 1080,
      codecs: ["avc1.640029", "mp4a.40.2"],
    });
  });

  test("names each WebVTT rendition and keeps names unique", () => {
    const decision = decidePlayback(source, browser, { isLan: true });
    expect(sessionOutputs(decision, source, details).subtitles).toEqual([
      { index: 0, name: "nld", language: "nld", default: false, forced: true },
      { index: 2, name: "eng", language: "eng", default: true, forced: false },
      {
        index: 3,
        name: "Subtitles 4",
        language: null,
        default: false,
        forced: false,
      },
    ]);
    const twins = sessionOutputs(decision, source, [
      { language: "eng", title: "English", disposition: {} },
      { language: "eng", title: null, disposition: {} },
      { language: "eng", title: "English", disposition: {} },
      { language: "deu", title: "Deutsch", disposition: {} },
    ]).subtitles.map((subtitle) => subtitle.name);
    expect(twins).toEqual(["English (1)", "English (3)", "Deutsch"]);
  });

  test("a selection maps its audio Stream and lists only its chosen subtitle as the default", () => {
    const dubbed: PlaybackSource = {
      ...source,
      audio: [
        { codec: "ac3", channels: 6, bitrate: 448_000 },
        { codec: "aac", channels: 2, bitrate: 128_000 },
      ],
      selection: { audio: 1, subtitle: 3 },
    };
    const outputs = sessionOutputs(
      decidePlayback(dubbed, browser, { isLan: true }),
      dubbed,
      details,
    );
    expect(outputs.audioStream).toBe(1);
    expect(outputs.audio).toEqual({
      action: "copy",
      codec: "aac",
      channels: 2,
    });
    expect(outputs.variant.codecs).toEqual(["avc1.640029", "mp4a.40.2"]);
    expect(outputs.burnSubtitle).toBeUndefined();
    expect(outputs.subtitles).toEqual([
      {
        index: 3,
        name: "Subtitles 4",
        language: null,
        default: true,
        forced: false,
      },
    ]);
  });

  test("subtitles off burn nothing and list nothing, with or without a live decision", () => {
    const off: PlaybackSource = { ...source, selection: { subtitle: null } };
    const live = sessionOutputs(
      decidePlayback(off, browser, { isLan: true }),
      off,
      details,
    );
    const stored = sessionOutputs(
      { method: "stored", selection: { audio: 0, subtitle: null } },
      source,
      details,
    );
    for (const outputs of [live, stored]) {
      expect(outputs.burnSubtitle).toBeUndefined();
      expect(outputs.subtitles).toEqual([]);
    }
  });

  test("an audio-only mismatch copies video and encodes EAC3 5.1 for a receiver", () => {
    const receiver: ClientProfile = {
      ...browser,
      videoCodecs: [{ codec: "hevc" }],
      audioCodecs: [
        { codec: "aac", maxChannels: 2 },
        { codec: "eac3", maxChannels: 6 },
      ],
      subtitleFormats: ["webvtt", "pgs"],
    };
    const lossless: PlaybackSource = {
      ...source,
      audio: [{ codec: "truehd", channels: 8, bitrate: 3_000_000 }],
    };
    const outputs = sessionOutputs(
      decidePlayback(lossless, receiver, { isLan: true }),
      lossless,
      details,
    );
    expect(outputs.video.action).toBe("copy");
    expect(outputs.audio).toEqual({
      action: "transcode",
      codec: "eac3",
      channels: 6,
    });
    expect(outputs.burnSubtitle).toBeUndefined();
    expect(outputs.variant.codecs).toEqual(["hvc1.1.6.L120.B0", "ec-3"]);
    expect(outputs.variant.bandwidth).toBe(8_000_000 + 640_000);
  });
});
