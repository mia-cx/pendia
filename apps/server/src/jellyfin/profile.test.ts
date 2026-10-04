import { describe, expect, test } from "bun:test";
import { AuthError } from "../auth/errors.ts";
import { decidePlayback } from "../playback/decisions.ts";
import type { Hdr } from "../playback/policy.ts";
import { readDeviceProfile } from "./profile.ts";
import { deviceProfiles } from "./profile-fixtures.ts";

const everyFlavour: Hdr[] = ["sdr", "hdr10", "hdr10+", "hlg", "dolby-vision"];

describe("DeviceProfile translation", () => {
  test("a direct-play client keeps its containers, TrueHD and embedded subtitles", () => {
    const profile = readDeviceProfile(deviceProfiles.infuse);
    expect(profile.containers).toEqual(["mkv", "mp4", "mov"]);
    expect(profile.videoCodecs.map((entry) => entry.codec)).toEqual([
      "h264",
      "hevc",
      "av1",
      "vp9",
      "mpeg2video",
    ]);
    expect(profile.audioCodecs).toContainEqual({
      codec: "truehd",
      maxChannels: 8,
    });
    expect(profile.audioCodecs.map((entry) => entry.codec)).toContain("dts-hd");
    expect(profile.subtitleFormats).toEqual(["srt", "ass", "pgs"]);
    expect(profile.hdr).toEqual(everyFlavour);
    expect(profile.maxBitrate).toBe(120_000_000);
  });

  test("an HLS-only client opens no files and decodes its transcoding codecs", () => {
    const profile = readDeviceProfile(deviceProfiles.swiftfin);
    expect(profile.containers).toEqual([]);
    expect(profile.videoCodecs).toEqual([
      {
        codec: "h264",
        profiles: ["high", "main", "baseline", "constrainedbaseline"],
        maxLevel: 52,
        maxWidth: undefined,
        maxHeight: undefined,
      },
      {
        codec: "hevc",
        maxLevel: undefined,
        maxWidth: undefined,
        maxHeight: undefined,
      },
    ]);
    expect(profile.audioCodecs.map((entry) => entry.codec)).toEqual([
      "aac",
      "ac3",
      "eac3",
    ]);
    // Only Embed counts: HLS subtitles convert to WebVTT whatever the client says.
    expect(profile.subtitleFormats).toEqual([]);
    expect(profile.hdr).toEqual(["sdr", "hdr10", "hlg"]);
  });

  test("Findroid's empty profile accepts nothing, so no path plays", () => {
    const profile = readDeviceProfile(deviceProfiles.findroid);
    expect(profile).toMatchObject({
      containers: [],
      videoCodecs: [],
      audioCodecs: [],
      subtitleFormats: [],
      maxBitrate: 1_000_000_000,
    });
    expect(() =>
      decidePlayback(
        {
          container: "mkv",
          video: {
            codec: "h264",
            profile: "high",
            level: 40,
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            hdr: "sdr",
          },
          audio: [{ codec: "aac", channels: 2 }],
          subtitles: [],
        },
        profile,
        { isLan: true },
      ),
    ).toThrow();
  });

  test("unknown names count as unsupported, and keys match in any case", () => {
    const profile = readDeviceProfile(
      {
        directPlayProfiles: [
          {
            type: "Video",
            container: "mkv,flv",
            videoCodec: "h264,realvideo",
            audioCodec: "AAC,wma",
          },
        ],
        subtitleProfiles: [{ format: "PGSSUB", method: "embed" }],
      },
      8_000_000,
    );
    expect(profile).toMatchObject({
      containers: ["mkv"],
      videoCodecs: [{ codec: "h264" }],
      audioCodecs: [{ codec: "aac", maxChannels: 8 }],
      subtitleFormats: ["pgs"],
      maxBitrate: 8_000_000,
    });
  });

  test("audio channel caps and conditional profiles", () => {
    const profile = readDeviceProfile({
      DirectPlayProfiles: [
        { Container: "mp4", VideoCodec: "h264", AudioCodec: "aac,eac3" },
      ],
      CodecProfiles: [
        {
          Type: "VideoAudio",
          Codec: "aac",
          Conditions: [
            {
              Condition: "LessThanEqual",
              Property: "AudioChannels",
              Value: "2",
            },
          ],
        },
        // Applies only when its own conditions hold, so it narrows nothing.
        {
          Type: "Video",
          Codec: "h264",
          Conditions: [
            { Condition: "LessThanEqual", Property: "Width", Value: "1280" },
          ],
          ApplyConditions: [
            { Condition: "Equals", Property: "IsAnamorphic", Value: "true" },
          ],
        },
      ],
    });
    expect(profile.audioCodecs).toEqual([
      { codec: "aac", maxChannels: 2 },
      { codec: "eac3", maxChannels: 8 },
    ]);
    expect(profile.videoCodecs[0]?.maxWidth).toBeUndefined();
  });

  test("a malformed profile is invalid input", () => {
    expect(() => readDeviceProfile({ DirectPlayProfiles: "mkv" })).toThrow(
      AuthError,
    );
  });
});
