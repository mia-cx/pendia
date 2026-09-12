import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  groups,
  libraries,
  libraryAccess,
  type Permission,
  permissions,
  userGroups,
  users,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  checkPermission,
  createGroup,
  setPermissionOverride,
  setUserGroups,
} from "./permissions.ts";

async function createUser(
  db: Database,
  username: string,
  groupNames: string[] = [],
) {
  const [user] = await db
    .insert(users)
    .values({ username, displayName: username, passwordHash: "fixture" })
    .returning();
  if (!user) throw new Error("Fixture user missing.");
  if (groupNames.length) {
    const all = await db.select().from(groups);
    const ids = groupNames.map((name) => {
      const group = all.find((g) => g.name === name);
      if (!group) throw new Error(`Fixture group ${name} missing.`);
      return group.id;
    });
    await db
      .insert(userGroups)
      .values(ids.map((groupId) => ({ userId: user.id, groupId })));
  }
  return user;
}

async function createLibrary(db: Database, name: string) {
  const [library] = await db
    .insert(libraries)
    .values({ name, medium: "shows", rootPath: `/${name}` })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  return library;
}

const management = permissions.filter((p) => p !== "view" && p !== "play");

describe.skipIf(!databaseUrl)("auth permissions", () => {
  test("seeded users member grants view and play, denies management", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const user = await createUser(db, "viewer", ["users"]);
      expect(await checkPermission(db, user.id, "view")).toBe(true);
      expect(await checkPermission(db, user.id, "play")).toBe(true);
      for (const permission of management)
        expect(await checkPermission(db, user.id, permission)).toBe(false);
    }));

  test("seeded admins member bypasses overrides and library denies", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      for (const permission of permissions)
        expect(await checkPermission(db, admin.id, permission)).toBe(true);
      await setPermissionOverride(db, admin.id, admin.id, "view", false);
      const library = await createLibrary(db, "denied");
      const [admins] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "admins"));
      if (!admins) throw new Error("Seed group missing.");
      await db
        .insert(libraryAccess)
        .values({ libraryId: library.id, groupId: admins.id, allowed: false });
      expect(await checkPermission(db, admin.id, "view", library.id)).toBe(
        true,
      );
      expect(await checkPermission(db, admin.id, "view")).toBe(true);
    }));

  test("custom groups union permissions and never bypass like admins", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const metadata = await createGroup(db, admin.id, {
        name: "metadata",
        permissions: ["manage-metadata"],
      });
      const subtitles = await createGroup(db, admin.id, {
        name: "subtitles",
        permissions: ["manage-subtitles"],
      });
      const user = await createUser(db, "editor");
      await setUserGroups(db, admin.id, user.id, [metadata.id, subtitles.id]);
      expect(await checkPermission(db, user.id, "manage-metadata")).toBe(true);
      expect(await checkPermission(db, user.id, "manage-subtitles")).toBe(true);
      expect(await checkPermission(db, user.id, "manage-users")).toBe(false);
      await setPermissionOverride(
        db,
        admin.id,
        user.id,
        "manage-metadata",
        false,
      );
      expect(await checkPermission(db, user.id, "manage-metadata")).toBe(false);
      await setPermissionOverride(
        db,
        admin.id,
        user.id,
        "manage-libraries",
        true,
      );
      expect(await checkPermission(db, user.id, "manage-libraries")).toBe(true);
      await setPermissionOverride(
        db,
        admin.id,
        user.id,
        "manage-metadata",
        null,
      );
      expect(await checkPermission(db, user.id, "manage-metadata")).toBe(true);
    }));

  test("library rows override the global view result and deny wins ties", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const allowed = await createGroup(db, admin.id, {
        name: "allowed",
        permissions: ["view"],
      });
      const denied = await createGroup(db, admin.id, {
        name: "denied",
        permissions: ["view"],
      });
      const library = await createLibrary(db, "library");
      const other = await createLibrary(db, "other");
      const user = await createUser(db, "member");
      await setUserGroups(db, admin.id, user.id, [allowed.id, denied.id]);

      await db.insert(libraryAccess).values([
        { libraryId: library.id, userId: user.id, allowed: true },
        { libraryId: library.id, groupId: denied.id, allowed: false },
      ]);
      expect(await checkPermission(db, user.id, "view", library.id)).toBe(
        false,
      );
      expect(await checkPermission(db, user.id, "view", other.id)).toBe(true);

      const outsider = await createUser(db, "outsider");
      expect(await checkPermission(db, outsider.id, "view")).toBe(false);
      await db.insert(libraryAccess).values({
        libraryId: library.id,
        userId: outsider.id,
        allowed: true,
      });
      expect(await checkPermission(db, outsider.id, "view", library.id)).toBe(
        true,
      );
      expect(await checkPermission(db, outsider.id, "play", library.id)).toBe(
        false,
      );
      await db.insert(libraryAccess).values({
        libraryId: other.id,
        groupId: allowed.id,
        allowed: false,
      });
      expect(await checkPermission(db, user.id, "view", other.id)).toBe(false);
    }));

  test("missing or disabled users hold no permission, even as admins", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      expect(
        await checkPermission(db, Bun.randomUUIDv7(), "manage-users"),
      ).toBe(false);
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, admin.id));
      expect(await checkPermission(db, admin.id, "manage-server")).toBe(false);
      await expect(
        setUserGroups(db, admin.id, admin.id, []),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));

  test("manage-users cannot grant groups or override permissions", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const managerGroup = await createGroup(db, admin.id, {
        name: "managers",
        permissions: ["manage-users"],
      });
      const manager = await createUser(db, "manager");
      await setUserGroups(db, admin.id, manager.id, [managerGroup.id]);
      const allPermissions = await createGroup(db, admin.id, {
        name: "all-permissions",
        permissions: [...permissions],
      });
      const [admins] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "admins"));
      if (!admins) throw new Error("Seed group missing.");
      expect(await checkPermission(db, manager.id, "manage-users")).toBe(true);
      await expect(
        createGroup(db, manager.id, {
          name: "escalated",
          permissions: ["manage-server"],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      for (const groupId of [allPermissions.id, admins.id])
        await expect(
          setUserGroups(db, manager.id, manager.id, [groupId]),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setPermissionOverride(
          db,
          manager.id,
          manager.id,
          "manage-server",
          true,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setPermissionOverride(
          db,
          manager.id,
          manager.id,
          "manage-server",
          null,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await checkPermission(db, manager.id, "manage-server")).toBe(
        false,
      );
    }));

  test("membership replacement preserves the final enabled admin", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const disabled = await createUser(db, "disabled", ["admins"]);
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, disabled.id));
      const [members] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "users"));
      if (!members) throw new Error("Seed group missing.");
      for (const groupIds of [[], [members.id]]) {
        await expect(
          setUserGroups(db, admin.id, admin.id, groupIds),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await checkPermission(db, admin.id, "manage-users")).toBe(true);
      }
      const replacement = await createUser(db, "replacement", ["admins"]);
      await setUserGroups(db, admin.id, admin.id, [members.id]);
      expect(await checkPermission(db, admin.id, "manage-users")).toBe(false);
      expect(await checkPermission(db, replacement.id, "manage-users")).toBe(
        true,
      );
    }));

  test("concurrent admin demotions preserve one enabled admin", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const first = await createUser(db, "first", ["admins"]);
      const other = await createUser(db, "other", ["admins"]);
      const second = createDatabase(url);
      try {
        const results = await Promise.allSettled([
          setUserGroups(db, first.id, first.id, []),
          setUserGroups(second.db, other.id, other.id, []),
        ]);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        const rejected = results.find((result) => result.status === "rejected");
        expect(rejected).toMatchObject({
          status: "rejected",
          reason: { code: "CONFLICT" },
        });
        const enabled = await Promise.all([
          checkPermission(db, first.id, "manage-users"),
          checkPermission(db, other.id, "manage-users"),
        ]);
        expect(enabled.filter(Boolean)).toHaveLength(1);
      } finally {
        await second.close();
      }
    }));

  test("mutations require built-in admins and validate groups", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const ordinary = await createUser(db, "ordinary", ["users"]);
      const custom = await createGroup(db, admin.id, {
        name: "editors",
        permissions: ["view"],
      });
      await expect(
        createGroup(db, ordinary.id, { name: "nope", permissions: [] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setUserGroups(db, ordinary.id, ordinary.id, [custom.id]),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        setPermissionOverride(db, ordinary.id, ordinary.id, "view", true),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const member = await createUser(db, "member");
      await setUserGroups(db, admin.id, member.id, [custom.id]);
      expect(await checkPermission(db, member.id, "view")).toBe(true);
      await setUserGroups(db, admin.id, member.id, []);
      expect(await checkPermission(db, member.id, "view")).toBe(false);
      await expect(
        setUserGroups(db, admin.id, member.id, [Bun.randomUUIDv7()]),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setUserGroups(db, admin.id, Bun.randomUUIDv7(), []),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setPermissionOverride(db, admin.id, Bun.randomUUIDv7(), "view", true),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      for (const name of ["admins", "USERS", "  ", "x".repeat(81)])
        await expect(
          createGroup(db, admin.id, { name, permissions: [] }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        createGroup(db, admin.id, {
          name: "bad",
          permissions: ["nope" as Permission],
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        createGroup(db, admin.id, { name: "editors", permissions: [] }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }));

  test("concurrent membership replacements leave exactly one result", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const admin = await createUser(db, "admin", ["admins"]);
      const metadata = await createGroup(db, admin.id, {
        name: "metadata",
        permissions: ["manage-metadata"],
      });
      const subtitles = await createGroup(db, admin.id, {
        name: "subtitles",
        permissions: ["manage-subtitles"],
      });
      const target = await createUser(db, "target");
      const second = createDatabase(url);
      try {
        await Promise.all([
          setUserGroups(db, admin.id, target.id, [metadata.id]),
          setUserGroups(second.db, admin.id, target.id, [subtitles.id]),
        ]);
        const result = await Promise.all([
          checkPermission(db, target.id, "manage-metadata"),
          checkPermission(db, target.id, "manage-subtitles"),
        ]);
        expect(result).toSatisfy(
          (r) =>
            (r[0] === true && r[1] === false) ||
            (r[0] === false && r[1] === true),
        );
      } finally {
        await second.close();
      }
    }));
});
