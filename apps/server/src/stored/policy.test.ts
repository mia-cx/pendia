import { describe, expect, test } from "bun:test";
import { migrateDatabase } from "../db/migrate.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  defaultIdleWindow,
  idleWindowAt,
  policyMatches,
  readStoredVersionPolicy,
  readStoreSettings,
  rungFits,
} from "./policy.ts";

const when = { minHeight: 2160, codecs: ["hevc"], hdr: true };
const policy: JsonObject = {
  rungs: [{ name: "source" }, { name: "1080p", height: 1080, bitrate: 8e6 }],
  when,
};

describe("readStoredVersionPolicy", () => {
  test("decodes the policy and reads a missing one as null", () => {
    expect(readStoredVersionPolicy({ storedVersions: policy })).toEqual({
      rungs: [
        { name: "source" },
        { name: "1080p", height: 1080, bitrate: 8e6 },
      ],
      when,
    });
    expect(readStoredVersionPolicy({})).toBeNull();
    expect(readStoredVersionPolicy({ storedVersions: null })).toBeNull();
  });

  test.each([
    ["no rungs", { rungs: [] }],
    ["a duplicate name", { rungs: [{ name: "source" }, { name: "source" }] }],
    [
      "an encoded rung named source",
      { rungs: [{ name: "source", height: 720, bitrate: 3e6 }] },
    ],
    ["an odd height", { rungs: [{ name: "odd", height: 721, bitrate: 3e6 }] }],
    [
      "a path in the name",
      { rungs: [{ name: "../x", height: 720, bitrate: 3e6 }] },
    ],
    ["a missing bitrate", { rungs: [{ name: "720p", height: 720 }] }],
  ])("rejects %s", (_name, value) => {
    expect(() => readStoredVersionPolicy({ storedVersions: value })).toThrow();
  });
});

describe("policyMatches", () => {
  const sdr1080 = { codec: "h264", height: 1080, hdr: "sdr" };

  test("matches every source without a condition", () => {
    expect(policyMatches(undefined, sdr1080)).toBe(true);
  });

  test("matches when any one criterion holds", () => {
    expect(policyMatches(when, sdr1080)).toBe(false);
    expect(policyMatches(when, { ...sdr1080, height: 2160 })).toBe(true);
    expect(policyMatches(when, { ...sdr1080, codec: "hevc" })).toBe(true);
    expect(policyMatches(when, { ...sdr1080, hdr: "hdr10" })).toBe(true);
  });

  test("an empty condition matches nothing", () => {
    expect(policyMatches({}, sdr1080)).toBe(false);
  });
});

describe("rungFits", () => {
  test("skips an encode taller than the source", () => {
    const rung = { name: "1080p", height: 1080, bitrate: 8e6 };
    expect(rungFits(rung, { codec: "h264", height: 1080, hdr: "sdr" })).toBe(
      true,
    );
    expect(rungFits(rung, { codec: "h264", height: 720, hdr: "sdr" })).toBe(
      false,
    );
  });

  test("remuxes only codecs fMP4 can carry", () => {
    const rung = { name: "source" as const };
    expect(rungFits(rung, { codec: "hevc", height: 2160, hdr: "sdr" })).toBe(
      true,
    );
    expect(rungFits(rung, { codec: "vc1", height: 1080, hdr: "sdr" })).toBe(
      false,
    );
  });
});

describe("idleWindowAt", () => {
  const local = (day: number, hours: number, minutes = 0) =>
    new Date(2026, 9, day, hours, minutes);

  test("a same-day window", () => {
    const window = { start: "01:00", end: "07:00" };
    expect(idleWindowAt(window, local(1, 0, 59))).toEqual({
      inside: false,
      startsAt: local(1, 1),
    });
    expect(idleWindowAt(window, local(1, 1))).toEqual({
      inside: true,
      endsAt: local(1, 7),
    });
    expect(idleWindowAt(window, local(1, 7))).toEqual({
      inside: false,
      startsAt: local(2, 1),
    });
  });

  test("a window across midnight", () => {
    const window = { start: "22:30", end: "06:00" };
    expect(idleWindowAt(window, local(1, 23))).toEqual({
      inside: true,
      endsAt: local(2, 6),
    });
    expect(idleWindowAt(window, local(2, 5, 59))).toEqual({
      inside: true,
      endsAt: local(2, 6),
    });
    expect(idleWindowAt(window, local(2, 12))).toEqual({
      inside: false,
      startsAt: local(2, 22, 30),
    });
  });

  test("equal ends are open all day", () => {
    expect(
      idleWindowAt({ start: "00:00", end: "00:00" }, local(1, 13)),
    ).toEqual({ inside: true, endsAt: null });
  });
});

describe.skipIf(!databaseUrl)("readStoreSettings", () => {
  test("defaults the window and reads a configured one", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      expect(await readStoreSettings(db)).toEqual({
        idleWindow: defaultIdleWindow,
      });
      await db.insert(settings).values({
        key: "store",
        value: { idleWindow: { start: "23:00", end: "05:30" } },
      });
      expect(await readStoreSettings(db)).toEqual({
        idleWindow: { start: "23:00", end: "05:30" },
      });
    }));
});
