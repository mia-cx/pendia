import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  apiKeys,
  invites,
  permissions,
  sessions,
  userGroups,
  users,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import { checkPermission } from "./permissions.ts";

describe.skipIf(!databaseUrl)("auth accounts", () => {
  test("setup creates one enabled admin with an argon2id hash", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: " Admin ",
        password: "correct horse",
      });
      expect(admin).toEqual({
        id: admin.id,
        username: "admin",
        displayName: "admin",
      });
      for (const permission of permissions)
        expect(await checkPermission(db, admin.id, permission)).toBe(true);
      const [stored] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, admin.id));
      expect(stored?.passwordHash).toStartWith("$argon2id$");
      expect(
        await Bun.password.verify("correct horse", stored?.passwordHash ?? ""),
      ).toBe(true);
      expect(
        await Bun.password.verify("wrong", stored?.passwordHash ?? ""),
      ).toBe(false);
    }));

  test("concurrent setup creates exactly one admin and stays closed", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const second = createDatabase(url);
      try {
        const results = await Promise.allSettled([
          setupAdmin(db, { username: "one", password: "first" }),
          setupAdmin(second.db, { username: "two", password: "second" }),
        ]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(
          rejected[0]?.status === "rejected" ? rejected[0].reason : undefined,
        ).toMatchObject({ code: "SETUP_COMPLETE" });
        expect(await db.select().from(users)).toHaveLength(1);
        expect(await db.select().from(userGroups)).toHaveLength(1);
        expect(await db.select().from(sessions)).toHaveLength(0);
        expect(await db.select().from(apiKeys)).toHaveLength(0);
        expect(await db.select().from(invites)).toHaveLength(0);

        await expect(
          setupAdmin(db, { username: "three", password: "third" }),
        ).rejects.toMatchObject({ code: "SETUP_COMPLETE" });
        const winner =
          fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value : undefined;
        if (!winner) throw new Error("Setup winner missing.");
        await db.delete(users).where(eq(users.id, winner.id));
        await expect(
          setupAdmin(db, { username: "four", password: "fourth" }),
        ).rejects.toMatchObject({ code: "SETUP_COMPLETE" });
      } finally {
        await second.close();
      }
    }));

  test("existing users close setup before marker or lock", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.insert(users).values({
        username: "existing",
        displayName: "Existing",
        passwordHash: "fixture",
      });
      await expect(
        setupAdmin(db, { username: "admin", password: "secret" }),
      ).rejects.toMatchObject({ code: "SETUP_COMPLETE" });
    }));

  test("createLocalUser validates, dedupes and requires manage-users", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "Viewer",
        password: "pass",
        displayName: " The Viewer ",
      });
      expect(viewer).toMatchObject({
        username: "viewer",
        displayName: "The Viewer",
      });
      expect(viewer).not.toHaveProperty("passwordHash");
      expect(await checkPermission(db, viewer.id, "view")).toBe(true);
      expect(await checkPermission(db, viewer.id, "play")).toBe(true);
      expect(await checkPermission(db, viewer.id, "manage-users")).toBe(false);

      await expect(
        createLocalUser(db, viewer.id, {
          username: "intruder",
          password: "pass",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        createLocalUser(db, admin.id, {
          username: " VIEWER ",
          password: "pass",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      for (const input of [
        { username: "bad name!", password: "pass" },
        { username: "valid", password: "" },
      ]) {
        const before = await db.select().from(users);
        await expect(
          createLocalUser(db, admin.id, input),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(await db.select().from(users)).toHaveLength(before.length);
      }
    }));
});
