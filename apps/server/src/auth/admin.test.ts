import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  groups,
  libraries,
  type Permission,
  userGroups,
  userPermissionOverrides,
  userSettings,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import {
  getUserAccess,
  listGroups,
  listUsers,
  setGroupPermissions,
  setLibraryAccess,
  writeUserSettings,
} from "./admin.ts";
import {
  checkPermission,
  createGroup,
  setPermissionOverride,
  setUserGroups,
} from "./permissions.ts";

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

async function seedManager(db: Database, adminId: string) {
  const managers = await createGroup(db, adminId, {
    name: "managers",
    permissions: ["manage-users"],
  });
  const manager = await createLocalUser(db, adminId, {
    username: "manager",
    password: "manager-pass",
  });
  await setUserGroups(db, adminId, manager.id, [managers.id]);
  return manager;
}

async function createLibrary(db: Database, name: string) {
  const [library] = await db
    .insert(libraries)
    .values({ name, medium: "movies", rootPath: `/srv/${name}` })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  return library;
}

describe.skipIf(!databaseUrl)("auth admin", () => {
  test("listUsers and listGroups return ordered rows for manage-users", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await createLocalUser(db, admin.id, {
        username: "alice",
        password: "pass",
        displayName: "Alice",
      });
      const listed = await listUsers(db, admin.id);
      expect(listed.map((user) => user.username)).toEqual([
        "admin",
        "alice",
        "viewer",
      ]);
      expect(listed[0]).toMatchObject({
        username: "admin",
        displayName: "admin",
        email: null,
        disabledAt: null,
      });
      expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
        "createdAt",
        "disabledAt",
        "displayName",
        "email",
        "id",
        "username",
      ]);
      const listedGroups = await listGroups(db, admin.id);
      expect(listedGroups.map((group) => group.name)).toEqual([
        "admins",
        "users",
      ]);
      expect(listedGroups[0]).toMatchObject({
        name: "admins",
        builtIn: true,
        permissions: expect.any(Array),
      });
      const manager = await seedManager(db, admin.id);
      expect((await listUsers(db, manager.id)).length).toBeGreaterThan(0);
    }));

  test("getUserAccess returns groups, overrides, access rows and settings", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const library = await createLibrary(db, "movies");
      await setPermissionOverride(db, admin.id, viewer.id, "play", false);
      await db.insert(userSettings).values({
        userId: viewer.id,
        bitrateCapBps: 8_000_000n,
        contentRatingCeiling: "PG-13",
      });
      await setLibraryAccess(db, admin.id, {
        libraryId: library.id,
        userId: viewer.id,
        allowed: true,
      });
      const access = await getUserAccess(db, admin.id, viewer.id);
      const [usersGroup] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.name, "users"));
      if (!usersGroup) throw new Error("Seed group missing.");
      expect(access.user).toMatchObject({
        id: viewer.id,
        username: "viewer",
      });
      expect(access.groupIds).toEqual([usersGroup.id]);
      expect(access.overrides).toEqual([
        { permission: "play", allowed: false },
      ]);
      expect(access.libraryAccess).toEqual([
        { libraryId: library.id, allowed: true },
      ]);
      expect(access.settings).toEqual({
        bitrateCapBps: 8_000_000n,
        contentRatingCeiling: "PG-13",
      });
      const fresh = await getUserAccess(db, admin.id, admin.id);
      expect(fresh.settings).toEqual({
        bitrateCapBps: null,
        contentRatingCeiling: null,
      });
      expect(fresh.overrides).toEqual([]);
      expect(fresh.libraryAccess).toEqual([]);
    }));

  test("reads reject callers without manage-users", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { viewer } = await seed(db);
      await expect(listUsers(db, viewer.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(listGroups(db, viewer.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        getUserAccess(db, viewer.id, viewer.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        writeUserSettings(db, viewer.id, viewer.id, {
          bitrateCapBps: null,
          contentRatingCeiling: null,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        getUserAccess(db, viewer.id, Bun.randomUUIDv7()),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("getUserAccess on an unknown user is NOT_FOUND", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await expect(
        getUserAccess(db, admin.id, Bun.randomUUIDv7()),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }));

  test("setGroupPermissions edits custom groups only", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const custom = await createGroup(db, admin.id, {
        name: "editors",
        permissions: ["view"],
      });
      const updated = await setGroupPermissions(db, admin.id, custom.id, [
        "manage-metadata",
        "view",
        "manage-metadata",
      ]);
      expect(updated).toMatchObject({
        id: custom.id,
        name: "editors",
        builtIn: false,
        permissions: ["manage-metadata", "view"],
      });
      const [admins] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "admins"));
      if (!admins) throw new Error("Seed group missing.");
      await expect(
        setGroupPermissions(db, admin.id, admins.id, ["view"]),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        setGroupPermissions(db, admin.id, Bun.randomUUIDv7(), ["view"]),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setGroupPermissions(db, admin.id, custom.id, ["bogus" as Permission]),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const manager = await seedManager(db, admin.id);
      await expect(
        setGroupPermissions(db, manager.id, custom.id, ["view"]),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("writeUserSettings round trips bigint caps and clears the ceiling", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const big = 40_000_000_000n;
      const stored = await writeUserSettings(db, admin.id, viewer.id, {
        bitrateCapBps: big,
        contentRatingCeiling: "  TV-MA ",
      });
      expect(stored).toEqual({
        bitrateCapBps: big,
        contentRatingCeiling: "TV-MA",
      });
      const cleared = await writeUserSettings(db, admin.id, viewer.id, {
        bitrateCapBps: null,
        contentRatingCeiling: null,
      });
      expect(cleared).toEqual({
        bitrateCapBps: null,
        contentRatingCeiling: null,
      });
      for (const bitrateCapBps of [
        0n,
        -1n,
        BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      ])
        await expect(
          writeUserSettings(db, admin.id, viewer.id, {
            bitrateCapBps,
            contentRatingCeiling: null,
          }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      for (const contentRatingCeiling of ["   ", "x".repeat(65)])
        await expect(
          writeUserSettings(db, admin.id, viewer.id, {
            bitrateCapBps: null,
            contentRatingCeiling,
          }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        writeUserSettings(db, admin.id, Bun.randomUUIDv7(), {
          bitrateCapBps: null,
          contentRatingCeiling: null,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const [row] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, viewer.id));
      expect(row).toMatchObject({
        bitrateCapBps: null,
        contentRatingCeiling: null,
      });
    }));

  test("setLibraryAccess allows, denies and inherits with deny winning", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const library = await createLibrary(db, "movies");
      const [usersGroup] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "users"));
      if (!usersGroup) throw new Error("Seed group missing.");

      expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
        true,
      );
      await setLibraryAccess(db, admin.id, {
        libraryId: library.id,
        userId: viewer.id,
        allowed: false,
      });
      expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
        false,
      );
      await setLibraryAccess(db, admin.id, {
        libraryId: library.id,
        userId: viewer.id,
        allowed: true,
      });
      expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
        true,
      );
      await setLibraryAccess(db, admin.id, {
        libraryId: library.id,
        groupId: usersGroup.id,
        allowed: false,
      });
      expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
        false,
      );
      await setLibraryAccess(db, admin.id, {
        libraryId: library.id,
        groupId: usersGroup.id,
        allowed: null,
      });
      expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
        true,
      );
      await setLibraryAccess(db, admin.id, {
        libraryId: library.id,
        userId: viewer.id,
        allowed: null,
      });
      expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
        true,
      );
      const access = await getUserAccess(db, admin.id, viewer.id);
      expect(access.libraryAccess).toEqual([]);
    }));

  test("setLibraryAccess validates principals and known records", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const library = await createLibrary(db, "movies");
      const missing = Bun.randomUUIDv7();
      await expect(
        setLibraryAccess(db, admin.id, {
          libraryId: library.id,
          allowed: true,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        setLibraryAccess(db, admin.id, {
          libraryId: library.id,
          userId: viewer.id,
          groupId: missing,
          allowed: true,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        setLibraryAccess(db, admin.id, {
          libraryId: missing,
          userId: viewer.id,
          allowed: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setLibraryAccess(db, admin.id, {
          libraryId: library.id,
          userId: missing,
          allowed: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setLibraryAccess(db, admin.id, {
          libraryId: library.id,
          groupId: missing,
          allowed: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const manager = await seedManager(db, admin.id);
      await expect(
        setLibraryAccess(db, manager.id, {
          libraryId: library.id,
          userId: viewer.id,
          allowed: true,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const access = await getUserAccess(db, admin.id, viewer.id);
      expect(access.libraryAccess).toEqual([]);
    }));

  test("setLibraryAccess keeps both writers when the first row races", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const library = await createLibrary(db, "movies");
      await Promise.all([
        setLibraryAccess(db, admin.id, {
          libraryId: library.id,
          userId: viewer.id,
          allowed: true,
        }),
        setLibraryAccess(db, admin.id, {
          libraryId: library.id,
          userId: viewer.id,
          allowed: false,
        }),
      ]);
      const access = await getUserAccess(db, admin.id, viewer.id);
      const [stored] = access.libraryAccess;
      if (!stored) throw new Error("Access row missing.");
      expect([true, false]).toContain(stored.allowed);
    }));

  test("user_groups fixture rows appear as groupIds only", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const custom = await createGroup(db, admin.id, {
        name: "extra",
        permissions: ["view"],
      });
      await db
        .insert(userGroups)
        .values({ userId: viewer.id, groupId: custom.id });
      await db.insert(userPermissionOverrides).values({
        userId: viewer.id,
        permission: "manage-subtitles",
        allowed: true,
      });
      const access = await getUserAccess(db, admin.id, viewer.id);
      expect(access.groupIds).toHaveLength(2);
      expect(access.overrides).toEqual([
        { permission: "manage-subtitles", allowed: true },
      ]);
    }));
});
