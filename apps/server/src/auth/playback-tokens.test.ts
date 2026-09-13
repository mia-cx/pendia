import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  apiKeys,
  items,
  libraries,
  libraryAccess,
  sessionRegistry,
  sessions,
  settings,
  users,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import { setPermissionOverride } from "./permissions.ts";
import { issuePlaybackToken, verifyPlaybackToken } from "./playback-tokens.ts";
import {
  authenticate,
  createApiKey,
  login,
  revokeApiKey,
  revokeSession,
} from "./sessions.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const now = 1_800_000_000_000;
const expiry = 1_800_000_300;
const signingKeySetting = "auth.playbackSigningKey";

async function seedPlayback(db: Database, username = "owner") {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const owner = await createLocalUser(db, admin.id, {
    username,
    password: "owner-pass",
  });
  const { token: accountToken } = await login(
    db,
    { username, password: "owner-pass", ...device },
    "192.0.2.1",
  );
  const caller = await authenticate(db, accountToken);
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: "/srv/movies" })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  const [item] = await db
    .insert(items)
    .values({
      libraryId: library.id,
      kind: "movie",
      title: "Movie",
      canonicalFolder: "/srv/movies/movie",
    })
    .returning();
  if (!item) throw new Error("Item insert returned no row.");
  const [version] = await db
    .insert(versions)
    .values({
      itemId: item.id,
      itemKind: "movie",
      libraryId: library.id,
      label: "Original",
      format: "video",
      bytes: 1n,
    })
    .returning();
  if (!version) throw new Error("Version insert returned no row.");
  const [session] = await db
    .insert(sessionRegistry)
    .values({
      userId: owner.id,
      itemId: item.id,
      versionId: version.id,
      playMethod: "direct-play",
      state: "playing",
    })
    .returning();
  if (!session) throw new Error("Session insert returned no row.");
  return {
    admin,
    owner,
    caller,
    accountToken,
    library,
    item,
    version,
    session,
    scope: { sessionId: session.id, itemId: item.id },
  };
}

async function addSession(
  db: Database,
  userId: string,
  itemId: string,
  versionId: string,
) {
  const [session] = await db
    .insert(sessionRegistry)
    .values({
      userId,
      itemId,
      versionId,
      playMethod: "direct-play",
      state: "playing",
    })
    .returning();
  if (!session) throw new Error("Session insert returned no row.");
  return session;
}

async function addItem(db: Database, libraryId: string, title: string) {
  const [item] = await db
    .insert(items)
    .values({
      libraryId,
      kind: "movie",
      title,
      canonicalFolder: `/srv/movies/${title.toLowerCase()}`,
    })
    .returning();
  if (!item) throw new Error("Item insert returned no row.");
  return item;
}

function payloadOf(token: string): Record<string, unknown> {
  const [payload] = token.split(".");
  if (payload === undefined) throw new Error("Token has no payload.");
  const decoded: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("Token payload is not an object.");
  return decoded as Record<string, unknown>;
}

async function signingKey(db: Database) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, signingKeySetting))
    .limit(1);
  if (typeof row?.value !== "string")
    throw new Error("Playback signing key missing.");
  return Buffer.from(row.value, "base64url");
}

function forged(db: Database, body: object) {
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString(
    "base64url",
  );
  return signingKey(db).then(
    (key) =>
      `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`,
  );
}

describe.skipIf(!databaseUrl)("auth playback tokens", () => {
  test("round trip: issued claims verify against the live session", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);
      expect(issued.expiresAt).toBe("2027-01-15T08:05:00.000Z");
      expect(issued.token.split(".")).toHaveLength(2);
      expect(issued.token.length).toBeLessThanOrEqual(2048);
      expect(issued.token).not.toContain(fx.accountToken);
      expect(JSON.stringify(payloadOf(issued.token))).not.toContain(
        fx.accountToken,
      );

      const claims = await verifyPlaybackToken(db, issued.token, fx.scope, now);
      expect(claims).toEqual({
        v: 1,
        sessionId: fx.session.id,
        itemId: fx.item.id,
        userId: fx.owner.id,
        credential: fx.caller.credential,
        exp: expiry,
      });
    }));

  test("altered signatures and unsigned payload edits are rejected", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);

      const flipped = `${issued.token.slice(0, -1)}${
        issued.token.endsWith("A") ? "B" : "A"
      }`;
      await expect(
        verifyPlaybackToken(db, flipped, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

      const [, signature] = issued.token.split(".");
      const edited = Buffer.from(
        JSON.stringify({ ...payloadOf(issued.token), exp: expiry + 3600 }),
        "utf8",
      ).toString("base64url");
      await expect(
        verifyPlaybackToken(db, `${edited}.${signature}`, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("expiry rejects the token at the exact boundary second", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);
      const claims = await verifyPlaybackToken(
        db,
        issued.token,
        fx.scope,
        now + 299_999,
      );
      expect(claims.exp).toBe(expiry);
      await expect(
        verifyPlaybackToken(db, issued.token, fx.scope, now + 300_000),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("malformed and wrongly shaped tokens are rejected", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      await issuePlaybackToken(db, fx.caller, fx.scope, now);
      for (const token of [
        "",
        "not-a-token",
        "a.b.c",
        "x".repeat(2049),
        `!!!.${"A".repeat(43)}`,
        `${"e30"}.${"A".repeat(44)}`,
        `${"e30"}.${"A".repeat(43)}=`,
      ])
        await expect(
          verifyPlaybackToken(db, token, fx.scope, now),
        ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

      const token = await forged(db, {
        v: 2,
        sessionId: fx.session.id,
        itemId: fx.item.id,
        userId: fx.owner.id,
        credential: fx.caller.credential,
        exp: expiry,
      });
      await expect(
        verifyPlaybackToken(db, token, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("tokens bind to one session and one Item", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);

      const otherSession = await addSession(
        db,
        fx.owner.id,
        fx.item.id,
        fx.version.id,
      );
      await expect(
        verifyPlaybackToken(
          db,
          issued.token,
          { sessionId: otherSession.id, itemId: fx.item.id },
          now,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

      const otherItem = await addItem(db, fx.library.id, "Sequel");
      const [otherVersion] = await db
        .insert(versions)
        .values({
          itemId: otherItem.id,
          itemKind: "movie",
          libraryId: fx.library.id,
          label: "Original",
          format: "video",
          bytes: 1n,
        })
        .returning();
      if (!otherVersion) throw new Error("Version insert returned no row.");
      const otherItemSession = await addSession(
        db,
        fx.owner.id,
        otherItem.id,
        otherVersion.id,
      );
      await expect(
        verifyPlaybackToken(
          db,
          issued.token,
          { sessionId: otherItemSession.id, itemId: otherItem.id },
          now,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        verifyPlaybackToken(
          db,
          issued.token,
          { sessionId: fx.session.id, itemId: otherItem.id },
          now,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("a token signed by another database's key is rejected", () =>
    withDatabase((dbA) =>
      withDatabase(async (dbB) => {
        await migrateDatabase(dbA);
        await migrateDatabase(dbB);
        const fx = await seedPlayback(dbA);
        const issued = await issuePlaybackToken(dbA, fx.caller, fx.scope, now);
        await expect(
          verifyPlaybackToken(dbB, issued.token, fx.scope, now),
        ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      }),
    ));

  test("concurrent first issuance across clients shares one signing key", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const peer = createDatabase(url);
      try {
        const [a, b] = await Promise.all([
          issuePlaybackToken(db, fx.caller, fx.scope, now),
          issuePlaybackToken(peer.db, fx.caller, fx.scope, now),
        ]);
        expect(a.token).toBe(b.token);
        const keys = await db
          .select({ id: settings.id })
          .from(settings)
          .where(eq(settings.key, signingKeySetting));
        expect(keys).toHaveLength(1);
        const claims = await verifyPlaybackToken(
          peer.db,
          a.token,
          fx.scope,
          now,
        );
        expect(claims.userId).toBe(fx.owner.id);
      } finally {
        await peer.close();
      }
    }));

  test("stopped playback sessions reject issuance and verification", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);
      await db
        .update(sessionRegistry)
        .set({ state: "stopped" })
        .where(eq(sessionRegistry.id, fx.session.id));
      await expect(
        verifyPlaybackToken(db, issued.token, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        issuePlaybackToken(db, fx.caller, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("another user's session cannot be tokenised, even by an admin", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);

      const { token: adminToken } = await login(
        db,
        { username: "admin", password: "secret", ...device },
        "192.0.2.2",
      );
      const adminCaller = await authenticate(db, adminToken);
      await expect(
        issuePlaybackToken(db, adminCaller, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

      const other = await createLocalUser(db, fx.admin.id, {
        username: "other",
        password: "other-pass",
      });
      const foreign = await addSession(db, other.id, fx.item.id, fx.version.id);
      await expect(
        issuePlaybackToken(
          db,
          fx.caller,
          { sessionId: foreign.id, itemId: fx.item.id },
          now,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("disabling the owner invalidates outstanding tokens", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, fx.owner.id));
      await expect(
        verifyPlaybackToken(db, issued.token, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        issuePlaybackToken(db, fx.caller, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("revoking the issuing session or API key invalidates tokens", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const sessionIssued = await issuePlaybackToken(
        db,
        fx.caller,
        fx.scope,
        now,
      );
      const { token: keyToken } = await createApiKey(db, fx.owner.id, "bot");
      const keyCaller = await authenticate(db, keyToken);
      const keyIssued = await issuePlaybackToken(db, keyCaller, fx.scope, now);
      expect(
        (await verifyPlaybackToken(db, keyIssued.token, fx.scope, now))
          .credential.kind,
      ).toBe("api-key");

      await revokeSession(db, fx.admin.id, fx.caller.credential.id);
      await revokeApiKey(db, fx.admin.id, keyCaller.credential.id);
      for (const token of [sessionIssued.token, keyIssued.token])
        await expect(
          verifyPlaybackToken(db, token, fx.scope, now),
        ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        issuePlaybackToken(db, keyCaller, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("stored expiresAt on the issuing session or API key invalidates tokens", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const sessionIssued = await issuePlaybackToken(
        db,
        fx.caller,
        fx.scope,
        now,
      );
      const { token: keyToken } = await createApiKey(db, fx.owner.id, "bot");
      const keyCaller = await authenticate(db, keyToken);
      const keyIssued = await issuePlaybackToken(db, keyCaller, fx.scope, now);

      await db
        .update(sessions)
        .set({ expiresAt: sql`statement_timestamp() - interval '1 second'` })
        .where(eq(sessions.id, fx.caller.credential.id));
      await expect(
        verifyPlaybackToken(db, sessionIssued.token, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

      await db
        .update(apiKeys)
        .set({ expiresAt: sql`statement_timestamp() - interval '1 second'` })
        .where(eq(apiKeys.id, keyCaller.credential.id));
      await expect(
        verifyPlaybackToken(db, keyIssued.token, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("the auth session max-age applies to playback tokens", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);
      await db.insert(settings).values({
        key: "auth",
        value: { sessionMaxAgeSeconds: 3600 },
      });
      await db
        .update(sessions)
        .set({
          createdAt: sql`statement_timestamp() - interval '2 hours'`,
        })
        .where(eq(sessions.id, fx.caller.credential.id));
      await expect(
        verifyPlaybackToken(db, issued.token, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        issuePlaybackToken(db, fx.caller, fx.scope, now),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }));

  test("revoked library view and play permissions fail closed", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seedPlayback(db);
      const issued = await issuePlaybackToken(db, fx.caller, fx.scope, now);

      await db.insert(libraryAccess).values({
        libraryId: fx.library.id,
        userId: fx.owner.id,
        allowed: false,
      });
      await expect(
        verifyPlaybackToken(db, issued.token, fx.scope, now),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        issuePlaybackToken(db, fx.caller, fx.scope, now),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await db
        .delete(libraryAccess)
        .where(
          and(
            eq(libraryAccess.userId, fx.owner.id),
            eq(libraryAccess.libraryId, fx.library.id),
          ),
        );
      await setPermissionOverride(db, fx.admin.id, fx.owner.id, "play", false);
      await expect(
        verifyPlaybackToken(db, issued.token, fx.scope, now),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }));
});
