import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { apiKeys, sessions, userGroups, users } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import {
  authenticate,
  createApiKey,
  listApiKeys,
  listSessions,
  login,
  revokeApiKey,
  revokeSession,
} from "./sessions.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

async function createViewer(db: Database, username = "viewer2") {
  const [user] = await db
    .insert(users)
    .values({
      username,
      displayName: username,
      passwordHash: await Bun.password.hash("viewer-pass", {
        algorithm: "argon2id",
      }),
    })
    .returning();
  if (!user) throw new Error("Fixture user missing.");
  const all = await db.query.groups.findMany();
  const group = all.find((g) => g.name === "users");
  if (!group) throw new Error("Seeded users group missing.");
  await db.insert(userGroups).values({ userId: user.id, groupId: group.id });
  return user;
}

describe.skipIf(!databaseUrl)("auth sessions", () => {
  test("login returns an opaque token; revocation rejects the next call", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const first = await login(db, {
        username: " Admin ",
        password: "secret",
        ...device,
      });
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.user.id).toBe(admin.id);
      expect(first.session).toMatchObject({
        userId: admin.id,
        clientName: "Test Client",
        deviceId: "device-1",
        deviceName: "Living Room",
        expiresAt: null,
        revokedAt: null,
      });
      const digest = createHash("sha256").update(first.token).digest();
      const [stored] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, first.session.id));
      expect(stored?.tokenHash).toEqual(digest);
      const listed = await listSessions(db, admin.id);
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(first.token);

      const before = stored?.lastSeenAt;
      const authed = await authenticate(db, first.token);
      expect(authed.user.id).toBe(admin.id);
      expect(authed.credential).toEqual({
        kind: "session",
        id: first.session.id,
      });
      const [seen] = await db
        .select({ lastSeenAt: sessions.lastSeenAt })
        .from(sessions)
        .where(eq(sessions.id, first.session.id));
      expect(seen?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(
        before?.getTime() ?? 0,
      );

      const second = await login(db, {
        username: "admin",
        password: "secret",
        clientName: "Other",
        deviceId: "device-2",
        deviceName: "Bedroom",
      });
      expect(second.session.id).not.toBe(first.session.id);
      await revokeSession(db, admin.id, first.session.id);
      await expect(authenticate(db, first.token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      expect((await authenticate(db, second.token)).credential.kind).toBe(
        "session",
      );
      await revokeSession(db, admin.id, first.session.id);
    }));

  test("expiry is enforced and session management needs ownership or manage-users", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const expiring = await login(
        db,
        { username: "viewer", password: "viewer-pass", ...device },
        3600,
      );
      const [row] = await db
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.id, expiring.session.id));
      const [now] = await db.execute<{ now: Date }>(
        sql`select statement_timestamp() as now`,
      );
      if (!now) throw new Error("Statement timestamp missing.");
      expect(row?.expiresAt?.getTime()).toBeGreaterThan(now.now.getTime());
      await db
        .update(sessions)
        .set({ expiresAt: sql`statement_timestamp() - interval '1 second'` })
        .where(eq(sessions.id, expiring.session.id));
      await expect(authenticate(db, expiring.token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });

      const fresh = await login(db, {
        username: "viewer",
        password: "viewer-pass",
        ...device,
        deviceId: "device-3",
      });
      await expect(listSessions(db, viewer.id, admin.id)).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );
      const attacker = await createViewer(db);
      await expect(
        listSessions(db, attacker.id, viewer.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        revokeSession(db, attacker.id, fresh.session.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await revokeSession(db, admin.id, fresh.session.id);
      await expect(authenticate(db, fresh.token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    }));

  test("API keys authenticate, list safely, revoke and die with the owner", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const { token, key } = await createApiKey(db, admin.id, " Import Bot ");
      expect(key).toMatchObject({
        userId: admin.id,
        name: "Import Bot",
        expiresAt: null,
        revokedAt: null,
      });
      const [storedKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, key.id));
      expect(storedKey?.tokenHash).toEqual(
        createHash("sha256").update(token).digest(),
      );
      const listed = await listApiKeys(db, admin.id);
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(token);

      const authed = await authenticate(db, token);
      expect(authed.credential).toEqual({ kind: "api-key", id: key.id });
      const [used] = await db
        .select({ lastUsedAt: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, key.id));
      expect(used?.lastUsedAt).not.toBeNull();

      const session = await login(db, {
        username: "admin",
        password: "secret",
        ...device,
      });
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, admin.id));
      await expect(authenticate(db, token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      await expect(authenticate(db, session.token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      await expect(
        login(db, { username: "admin", password: "secret", ...device }),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      await db
        .update(users)
        .set({ disabledAt: null })
        .where(eq(users.id, admin.id));
      await revokeApiKey(db, admin.id, key.id);
      await expect(authenticate(db, token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    }));

  test("bad credentials and malformed tokens are rejected uniformly", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await setupAdmin(db, { username: "admin", password: "secret" });
      await db.insert(users).values({
        username: "oidc-only",
        displayName: "Oidc",
        oidcIssuer: "https://issuer.example",
        oidcSubject: "subject-1",
      });
      for (const input of [
        { username: "admin", password: "wrong" },
        { username: "ghost", password: "secret" },
        { username: "oidc-only", password: "secret" },
      ])
        await expect(login(db, { ...input, ...device })).rejects.toMatchObject({
          code: "INVALID_CREDENTIALS",
        });
      for (const token of ["", "short", "a".repeat(43), "!".repeat(43)])
        await expect(authenticate(db, token)).rejects.toMatchObject({
          code: "UNAUTHENTICATED",
        });
    }));
});
