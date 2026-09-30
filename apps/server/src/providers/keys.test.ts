import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import {
  readProviderKeyNames,
  removeProviderKey,
  setProviderKey,
} from "./keys.ts";

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  return { admin, viewer };
}

describe.skipIf(!databaseUrl)("provider keys", () => {
  test("set, list, overwrite and remove key names only", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      expect(await readProviderKeyNames(db)).toEqual([]);
      expect(
        await setProviderKey(db, admin.id, " TMDB ", "secret-one"),
      ).toEqual(["tmdb"]);
      expect(
        await setProviderKey(db, admin.id, "OpenSubtitles", "secret-two"),
      ).toEqual(["opensubtitles", "tmdb"]);
      expect(await readProviderKeyNames(db)).toEqual(["opensubtitles", "tmdb"]);
      expect(await setProviderKey(db, admin.id, "tmdb", "rotated")).toEqual([
        "opensubtitles",
        "tmdb",
      ]);
      expect(await removeProviderKey(db, admin.id, "TMDB")).toEqual([
        "opensubtitles",
      ]);
      expect(await readProviderKeyNames(db)).toEqual(["opensubtitles"]);
    }));

  test("storing a tmdb key marks only unmatched movies pending", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const [movieLibrary] = await db
        .insert(libraries)
        .values({ name: "Movies", medium: "movies", rootPath: "/m" })
        .returning();
      const [showLibrary] = await db
        .insert(libraries)
        .values({ name: "Shows", medium: "shows", rootPath: "/s" })
        .returning();
      if (!movieLibrary || !showLibrary) {
        throw new Error("Fixture libraries missing.");
      }
      const movie = await insertItem(db, {
        libraryId: movieLibrary.id,
        kind: "movie",
        title: "Unmatched Movie",
        canonicalFolder: "/m/unmatched",
        extension: {},
      });
      const show = await insertItem(db, {
        libraryId: showLibrary.id,
        kind: "show",
        title: "Unmatched Show",
        canonicalFolder: "/s/unmatched",
        extension: {},
      });
      await db
        .update(items)
        .set({ metadataState: "unmatched" })
        .where(eq(items.id, movie.id));
      await db
        .update(items)
        .set({ metadataState: "unmatched" })
        .where(eq(items.id, show.id));

      await setProviderKey(db, admin.id, "opensubtitles", "other-key");
      expect(
        (await db.select().from(items).where(eq(items.id, movie.id)))[0]
          ?.metadataState,
      ).toBe("unmatched");

      await setProviderKey(db, admin.id, "TMDB", "api-key");
      const rows = await db.select().from(items);
      expect(rows.find((row) => row.id === movie.id)?.metadataState).toBe(
        "pending",
      );
      expect(rows.find((row) => row.id === show.id)?.metadataState).toBe(
        "unmatched",
      );
    }));

  test("concurrent sets on a missing row keep both keys", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await Promise.all([
        setProviderKey(db, admin.id, "tmdb", "secret-one"),
        setProviderKey(db, admin.id, "tvdb", "secret-two"),
      ]);
      expect(await readProviderKeyNames(db)).toEqual(["tmdb", "tvdb"]);
    }));

  test("removing an unknown key is NOT_FOUND", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await expect(
        removeProviderKey(db, admin.id, "tmdb"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await setProviderKey(db, admin.id, "tmdb", "secret");
      await expect(
        removeProviderKey(db, admin.id, "tvdb"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }));

  test("inherited object names are not mistaken for stored keys", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await expect(
        removeProviderKey(db, admin.id, "constructor"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await setProviderKey(db, admin.id, "constructor", "secret"),
      ).toEqual(["constructor"]);
      expect(await readProviderKeyNames(db)).toEqual(["constructor"]);
      expect(await removeProviderKey(db, admin.id, "constructor")).toEqual([]);
      expect(await readProviderKeyNames(db)).toEqual([]);
    }));

  test("invalid names and values are INVALID_INPUT", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      for (const name of [
        "",
        "   ",
        "-tmdb",
        "tmdb!",
        "tv db",
        "x".repeat(65),
        "_tmdb",
      ])
        await expect(
          setProviderKey(db, admin.id, name, "secret"),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      for (const value of ["", "   ", "x".repeat(4097), "has\0nul"])
        await expect(
          setProviderKey(db, admin.id, "tmdb", value),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        removeProviderKey(db, admin.id, "bad name"),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await readProviderKeyNames(db)).toEqual([]);
    }));

  test("callers without manage-server are FORBIDDEN", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      await setProviderKey(db, admin.id, "tmdb", "secret");
      await expect(
        setProviderKey(db, viewer.id, "tvdb", "secret"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        removeProviderKey(db, viewer.id, "tmdb"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("no returned value ever contains a stored secret", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const secret = "super-secret-token-9f8e7d";
      const afterSet = await setProviderKey(db, admin.id, "tmdb", secret);
      const listed = await readProviderKeyNames(db);
      const afterRemove = await removeProviderKey(db, admin.id, "tmdb");
      for (const result of [afterSet, listed, afterRemove])
        expect(JSON.stringify(result)).not.toContain(secret);
    }));
});
