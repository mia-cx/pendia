import { describe, expect, test } from "bun:test";
import {
  droppedRungs,
  fromDraft,
  type StoredPolicy,
  toDraft,
} from "./stored.ts";

const policy: StoredPolicy = {
  rungs: [
    { name: "source" },
    { name: "1080p", height: 1080, bitrate: 8_000_000 },
  ],
  when: { minHeight: 2160, codecs: ["hevc", "av1"], hdr: true },
};

describe("stored policy drafts", () => {
  test("a saved policy round-trips through the editor", () => {
    expect(toDraft(policy)).toEqual({
      keepSource: true,
      rungs: [{ name: "1080p", height: "1080", bitrateMbps: "8" }],
      minHeight: "2160",
      codecs: "hevc, av1",
      hdr: true,
    });
    expect(fromDraft(toDraft(policy))).toEqual(policy);
  });

  test("blank names follow the height, blank conditions match every source, and no rung stores nothing", () => {
    expect(
      fromDraft({
        keepSource: false,
        rungs: [{ name: " ", height: "720", bitrateMbps: "2.5" }],
        minHeight: "",
        codecs: " , ",
        hdr: false,
      }),
    ).toEqual({ rungs: [{ name: "720p", height: 720, bitrate: 2_500_000 }] });
    expect(fromDraft(toDraft(null))).toBeNull();
  });

  test("a save names the rungs it drops", () => {
    expect(droppedRungs(policy, { rungs: [{ name: "source" }] })).toEqual([
      "1080p",
    ]);
    expect(droppedRungs(policy, null)).toEqual(["source", "1080p"]);
    expect(droppedRungs(null, policy)).toEqual([]);
  });
});
