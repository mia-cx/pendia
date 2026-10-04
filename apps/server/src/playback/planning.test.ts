import { describe, expect, test } from "bun:test";
import { migrateDatabase } from "../db/migrate.ts";
import {
  type TranscoderBackend,
  transcoderCapabilities,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { readCapabilityTable } from "./planning.ts";
import { cpuCapabilities } from "./policy.ts";

describe.skipIf(!databaseUrl)("readCapabilityTable", () => {
  const register = (
    db: Parameters<typeof migrateDatabase>[0],
    backends: TranscoderBackend[],
  ) =>
    db.insert(transcoderCapabilities).values({
      name: "node",
      address: "http://127.0.0.1:9",
      testedAt: new Date(),
      backends,
    });

  test("falls back to the built-in CPU table without a trialled node", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      expect(await readCapabilityTable(db)).toEqual(cpuCapabilities);
      await register(db, []);
      expect(await readCapabilityTable(db)).toEqual(cpuCapabilities);
    }));

  test("offers what every node's CPU passed, and no hardware", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await register(db, [
        {
          name: "cpu",
          codecs: ["h264", "hevc", "av1"],
          toneMapping: ["hdr10", "hdr10+", "dolby-vision", "hlg"],
        },
        { name: "nvenc", codecs: ["h264", "hevc"], toneMapping: [] },
      ]);
      await register(db, [
        { name: "cpu", codecs: ["hevc", "h264"], toneMapping: ["hdr10"] },
      ]);
      expect(await readCapabilityTable(db)).toEqual({
        cpu: { codecs: ["h264", "hevc"], toneMapping: ["hdr10"] },
      });
    }));
});
