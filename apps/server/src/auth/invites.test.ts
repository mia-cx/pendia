import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { migrateDatabase } from "../db/migrate.ts";
import {
  groups,
  invites,
  sessions,
  userGroups,
  users,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import { acceptLocalInvite, createInvite } from "./invites.ts";
import { authenticate } from "./sessions.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const account = {
  username: "newbie",
  password: "newbie-pass",
  ...device,
};

describe.skipIf(!databaseUrl)("auth invites", () => {
  test("admin creates invites; only the token digest is stored", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const { token, invite } = await createInvite(db, admin.id, {
        email: " Invitee@Example.COM ",
        expiresInSeconds: 3600,
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(invite).toEqual({
        id: invite.id,
        email: "invitee@example.com",
        invitedBy: admin.id,
        expiresAt: expect.any(Date),
        acceptedAt: null,
      });
      expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(JSON.stringify(invite)).not.toContain(token);
      const [stored] = await db
        .select()
        .from(invites)
        .where(eq(invites.id, invite.id));
      expect(stored?.tokenHash).toEqual(
        createHash("sha256").update(token).digest(),
      );
      for (const input of [
        { email: "not-an-email", expiresInSeconds: 60 },
        { email: "a@b", expiresInSeconds: 0 },
        { email: "a@b", expiresInSeconds: 315_360_001 },
        { email: "a@b", expiresInSeconds: 1.5 },
      ])
        await expect(createInvite(db, admin.id, input)).rejects.toMatchObject({
          code: "INVALID_INPUT",
        });
    }));

  test("creating invites requires manage-users", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "pass",
      });
      for (const actorId of [viewer.id, Bun.randomUUIDv7()])
        await expect(
          createInvite(db, actorId, {
            email: "invitee@example.com",
            expiresInSeconds: 60,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await db.select().from(invites)).toHaveLength(0);
    }));

  test("local acceptance creates the member, password and first session", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const { token: inviteToken, invite } = await createInvite(db, admin.id, {
        email: "newbie@example.com",
        expiresInSeconds: 600,
      });
      const accepted = await acceptLocalInvite(db, {
        token: inviteToken,
        username: " Newbie ",
        password: "newbie-pass",
        displayName: " New Bee ",
        ...device,
      });
      expect(accepted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(accepted.user).toEqual({
        id: accepted.user.id,
        username: "newbie",
        displayName: "New Bee",
      });
      expect(accepted.session).toMatchObject({
        userId: accepted.user.id,
        clientName: "Test Client",
        deviceId: "device-1",
        deviceName: "Living Room",
        expiresAt: null,
        revokedAt: null,
      });
      const [storedUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, accepted.user.id));
      expect(storedUser?.email).toBe("newbie@example.com");
      expect(storedUser?.passwordHash).toStartWith("$argon2id$");
      expect(
        await Bun.password.verify(
          "newbie-pass",
          storedUser?.passwordHash ?? "",
        ),
      ).toBe(true);
      const [membership] = await db
        .select({ name: groups.name })
        .from(userGroups)
        .innerJoin(groups, eq(groups.id, userGroups.groupId))
        .where(eq(userGroups.userId, accepted.user.id));
      expect(membership?.name).toBe("users");
      const [consumed] = await db
        .select({ acceptedAt: invites.acceptedAt })
        .from(invites)
        .where(eq(invites.id, invite.id));
      expect(consumed?.acceptedAt).not.toBeNull();
      const authed = await authenticate(db, accepted.token);
      expect(authed.user.id).toBe(accepted.user.id);
      expect(authed.credential).toEqual({
        kind: "session",
        id: accepted.session.id,
      });
    }));

  test("an invite works once and failures create nothing", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const { token } = await createInvite(db, admin.id, {
        email: "once@example.com",
        expiresInSeconds: 600,
      });
      await acceptLocalInvite(db, { token, ...account });
      const userCount = (await db.select().from(users)).length;
      for (const candidate of [
        { token, ...account, username: "second" },
        { token: "", ...account, username: "third" },
        { token: "short", ...account, username: "third" },
        { token: "!".repeat(43), ...account, username: "third" },
        { token: "a".repeat(43), ...account, username: "third" },
      ]) {
        await expect(acceptLocalInvite(db, candidate)).rejects.toMatchObject({
          code: "INVALID_INVITE",
        });
        expect(await db.select().from(users)).toHaveLength(userCount);
        expect(await db.select().from(sessions)).toHaveLength(1);
      }
    }));

  test("an expired invite rejects and stays unaccepted", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const { token, invite } = await createInvite(db, admin.id, {
        email: "late@example.com",
        expiresInSeconds: 600,
      });
      await db
        .update(invites)
        .set({ expiresAt: sql`statement_timestamp() - interval '1 second'` })
        .where(eq(invites.id, invite.id));
      await expect(
        acceptLocalInvite(db, { token, ...account }),
      ).rejects.toMatchObject({ code: "INVALID_INVITE" });
      const [stored] = await db
        .select({ acceptedAt: invites.acceptedAt })
        .from(invites)
        .where(eq(invites.id, invite.id));
      expect(stored?.acceptedAt).toBeNull();
      expect(await db.select().from(users)).toHaveLength(1);
      expect(await db.select().from(sessions)).toHaveLength(0);
    }));

  test("username and email conflicts roll back without burning the invite", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const { token } = await createInvite(db, admin.id, {
        email: "free@example.com",
        expiresInSeconds: 600,
      });
      await expect(
        acceptLocalInvite(db, {
          token,
          ...account,
          username: " ADMIN ",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const [stored] = await db
        .select({ acceptedAt: invites.acceptedAt })
        .from(invites)
        .where(eq(invites.email, "free@example.com"));
      expect(stored?.acceptedAt).toBeNull();
      expect(await db.select().from(users)).toHaveLength(1);
      const retried = await acceptLocalInvite(db, { token, ...account });
      expect(retried.user.username).toBe("newbie");

      await db.insert(users).values({
        username: "taken",
        displayName: "Taken",
        passwordHash: "fixture",
        email: "taken@example.com",
      });
      const { token: blocked } = await createInvite(db, admin.id, {
        email: "taken@example.com",
        expiresInSeconds: 600,
      });
      await expect(
        acceptLocalInvite(db, {
          token: blocked,
          ...account,
          username: "another",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const [storedBlocked] = await db
        .select({ acceptedAt: invites.acceptedAt })
        .from(invites)
        .where(eq(invites.email, "taken@example.com"));
      expect(storedBlocked?.acceptedAt).toBeNull();
      expect(await db.select().from(users)).toHaveLength(3);
      expect(await db.select().from(sessions)).toHaveLength(1);
    }));
});
