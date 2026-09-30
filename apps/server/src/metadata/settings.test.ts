import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { migrateDatabase } from "../db/migrate.ts";
import type { JsonValue } from "../db/schema/common.ts";
import { settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  type MetadataSettings,
  providersForLibrary,
  readMetadataSettings,
} from "./settings.ts";

describe.skipIf(!databaseUrl)("metadata settings", () => {
  test("missing metadata row returns documented defaults", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      expect(await readMetadataSettings(db)).toEqual({
        providerOrder: ["tmdb"],
        confidenceThreshold: 0.9,
        libraries: {},
        tmdb: null,
      });
    }));

  test("configured values trim the TMDB key and preserve unknown fields", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.insert(settings).values({
        key: "metadata",
        value: {
          providerOrder: ["tmdb", "musicbrainz"],
          confidenceThreshold: 0.5,
          libraries: { movies: ["musicbrainz", "tmdb"], shows: [] },
          tmdb: { apiKey: " secret-key " },
          futureOption: { nested: true },
        },
      });
      const config = await readMetadataSettings(db);
      expect(config).toMatchObject({
        providerOrder: ["tmdb", "musicbrainz"],
        confidenceThreshold: 0.5,
        libraries: { movies: ["musicbrainz", "tmdb"], shows: [] },
        tmdb: { apiKey: "secret-key" },
        futureOption: { nested: true },
      });
      expect(providersForLibrary(config, "movies")).toEqual([
        "tmdb",
        "musicbrainz",
      ]);
      expect(providersForLibrary(config, "shows")).toEqual([]);
    }));

  test("missing libraries inherit provider order and empty lists disable", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.insert(settings).values({
        key: "metadata",
        value: {
          providerOrder: ["tmdb", "musicbrainz"],
          libraries: { shows: [] },
        },
      });
      const config = await readMetadataSettings(db);
      expect(providersForLibrary(config, "movies")).toEqual([
        "tmdb",
        "musicbrainz",
      ]);
      expect(providersForLibrary(config, "shows")).toEqual([]);
    }));

  test("empty provider order disables providers and threshold bounds are inclusive", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.insert(settings).values({
        key: "metadata",
        value: {
          providerOrder: [],
          confidenceThreshold: 1,
          libraries: { movies: [] },
        },
      });
      const disabled = await readMetadataSettings(db);
      expect(providersForLibrary(disabled, "movies")).toEqual([]);
      expect(providersForLibrary(disabled, "shows")).toEqual([]);
      await db
        .update(settings)
        .set({ value: { confidenceThreshold: 0 } })
        .where(eq(settings.key, "metadata"));
      const lowest = await readMetadataSettings(db);
      expect(lowest.confidenceThreshold).toBe(0);
      expect(providersForLibrary(lowest, "movies")).toEqual(["tmdb"]);
    }));

  test("providersForLibrary returns fresh arrays callers cannot mutate", () => {
    const config: MetadataSettings = {
      providerOrder: ["tmdb"],
      confidenceThreshold: 0.9,
      libraries: { movies: ["tmdb"] },
      tmdb: null,
    };
    const enabled = providersForLibrary(config, "movies");
    enabled.push("bogus");
    expect(config.libraries.movies).toEqual(["tmdb"]);
    expect(providersForLibrary(config, "movies")).toEqual(["tmdb"]);
    const inherited = providersForLibrary(config, "shows");
    inherited.length = 0;
    expect(config.providerOrder).toEqual(["tmdb"]);
    expect(providersForLibrary(config, "shows")).toEqual(["tmdb"]);
  });

  test("malformed rows reject with the shared settings error", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.insert(settings).values({ key: "metadata", value: {} });
      await db.execute(
        sql`update settings set value = 'null'::jsonb where key = 'metadata'`,
      );
      await expect(readMetadataSettings(db)).rejects.toThrow(
        "Invalid metadata settings.",
      );
      const malformed: JsonValue[] = [
        "oops",
        42,
        [],
        { providerOrder: "tmdb" },
        { providerOrder: null },
        { providerOrder: [""] },
        { providerOrder: ["  "] },
        { providerOrder: [42] },
        { providerOrder: ["tmdb", "tmdb"] },
        { confidenceThreshold: "0.5" },
        { confidenceThreshold: null },
        { confidenceThreshold: -0.1 },
        { confidenceThreshold: 1.1 },
        { libraries: "all" },
        { libraries: [] },
        { libraries: null },
        { libraries: { movies: "tmdb" } },
        { libraries: { movies: ["tmdb", "tmdb"] } },
        { libraries: { movies: ["unknown"] } },
        { providerOrder: [], libraries: { movies: ["tmdb"] } },
        { tmdb: "key" },
        { tmdb: [] },
        { tmdb: {} },
        { tmdb: { apiKey: "" } },
        { tmdb: { apiKey: "   " } },
        { tmdb: { apiKey: 42 } },
      ];
      for (const value of malformed) {
        await db
          .update(settings)
          .set({ value })
          .where(eq(settings.key, "metadata"));
        await expect(readMetadataSettings(db)).rejects.toThrow(
          "Invalid metadata settings.",
        );
      }
    }));
});
