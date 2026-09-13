import { describe, expect, test } from "bun:test";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { listProviderKeys, removeProviderKey, setProviderKey } from "./keys.ts";

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
      expect(await listProviderKeys(db, admin.id)).toEqual([]);
      expect(
        await setProviderKey(db, admin.id, " TMDB ", "secret-one"),
      ).toEqual(["tmdb"]);
      expect(
        await setProviderKey(db, admin.id, "OpenSubtitles", "secret-two"),
      ).toEqual(["opensubtitles", "tmdb"]);
      expect(await listProviderKeys(db, admin.id)).toEqual([
        "opensubtitles",
        "tmdb",
      ]);
      expect(await setProviderKey(db, admin.id, "tmdb", "rotated")).toEqual([
        "opensubtitles",
        "tmdb",
      ]);
      expect(await removeProviderKey(db, admin.id, "TMDB")).toEqual([
        "opensubtitles",
      ]);
      expect(await listProviderKeys(db, admin.id)).toEqual(["opensubtitles"]);
    }));

  test("concurrent sets on a missing row keep both keys", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await Promise.all([
        setProviderKey(db, admin.id, "tmdb", "secret-one"),
        setProviderKey(db, admin.id, "tvdb", "secret-two"),
      ]);
      expect(await listProviderKeys(db, admin.id)).toEqual(["tmdb", "tvdb"]);
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
      for (const value of ["", "x".repeat(4097), "has\0nul"])
        await expect(
          setProviderKey(db, admin.id, "tmdb", value),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        removeProviderKey(db, admin.id, "bad name"),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await listProviderKeys(db, admin.id)).toEqual([]);
    }));

  test("callers without manage-server are FORBIDDEN", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      await setProviderKey(db, admin.id, "tmdb", "secret");
      await expect(listProviderKeys(db, viewer.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
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
      const listed = await listProviderKeys(db, admin.id);
      const afterRemove = await removeProviderKey(db, admin.id, "tmdb");
      for (const result of [afterSet, listed, afterRemove])
        expect(JSON.stringify(result)).not.toContain(secret);
    }));
});
