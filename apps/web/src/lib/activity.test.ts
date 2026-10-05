import { describe, expect, test } from "bun:test";
import {
  type ActivitySession,
  clientLabel,
  clock,
  deliveryLine,
  transcodeLine,
} from "./activity.ts";

const session: Pick<
  ActivitySession,
  | "playMethod"
  | "clientName"
  | "deviceName"
  | "rungs"
  | "transcoder"
  | "reasons"
> & { version: { label: string } } = {
  playMethod: "direct-play",
  clientName: "Pendia Web",
  deviceName: "iPad",
  version: { label: "1080p · H.264 · AC3" },
  rungs: ["source"],
  transcoder: null,
  reasons: [],
};

describe("clock", () => {
  test("reads m:ss under an hour and h:mm:ss from an hour", () => {
    expect(clock(95.7)).toBe("1:35");
    expect(clock(600)).toBe("10:00");
    expect(clock(3661)).toBe("1:01:01");
    expect(clock(-5)).toBe("0:00");
    expect(clock(Number.NaN)).toBe("0:00");
  });
});

describe("deliveryLine", () => {
  test("names the Version, plus stored rungs and the transcoder off-transcode", () => {
    expect(deliveryLine(session)).toBe("1080p · H.264 · AC3");
    expect(
      deliveryLine({ ...session, rungs: ["720p"], playMethod: "remux" }),
    ).toBe("1080p · H.264 · AC3 · 720p");
    expect(deliveryLine({ ...session, transcoder: "athena" })).toBe(
      "1080p · H.264 · AC3 · On athena",
    );
    expect(
      deliveryLine({ ...session, rungs: ["360p"], playMethod: "transcode" }),
    ).toBe("1080p · H.264 · AC3");
  });
});

describe("transcodeLine", () => {
  test("names the output, the node and each converted part", () => {
    expect(
      transcodeLine({
        rungs: ["1080p"],
        transcoder: "athena-hephaestus",
        reasons: ["video", "audio"],
      }),
    ).toBe("To 1080p on athena-hephaestus · Video converted · Audio converted");
    expect(
      transcodeLine({ rungs: ["360p"], transcoder: null, reasons: ["video"] }),
    ).toBe("To 360p · Video converted");
    expect(
      transcodeLine({
        rungs: ["source"],
        transcoder: "athena",
        reasons: ["audio"],
      }),
    ).toBe("On athena · Audio converted");
    expect(
      transcodeLine({
        rungs: ["360p", "720p"],
        transcoder: null,
        reasons: ["subtitles", "hdr"],
      }),
    ).toBe("To 360p, 720p · Subtitles burned in · HDR mapped to SDR");
  });
});

describe("clientLabel", () => {
  test("names the app, the device, or Unknown app", () => {
    expect(clientLabel(session)).toBe("Pendia Web on iPad");
    expect(clientLabel({ ...session, deviceName: null })).toBe("Pendia Web");
    expect(clientLabel({ ...session, clientName: null })).toBe("Unknown app");
  });
});
