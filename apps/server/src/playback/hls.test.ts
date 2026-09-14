import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import { issuePlaybackToken } from "../auth/playback-tokens.ts";
import { authenticate, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  items,
  libraries,
  sessionRegistry,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { authorizeHlsRequest, type HlsPrefix, parseHlsPath } from "./hls.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

describe("parseHlsPath", () => {
  const prefixes: HlsPrefix[] = ["/api/playback", "/internal/playback"];
  for (const prefix of prefixes) {
    test(`parses the HLS names under ${prefix}`, () => {
      const base = `${prefix}/session-1/item-2/hls`;
      expect(parseHlsPath(`${base}/master.m3u8`, prefix)).toEqual({
        sessionId: "session-1",
        itemId: "item-2",
        name: { kind: "master" },
      });
      expect(parseHlsPath(`${base}/media.m3u8`, prefix)?.name).toEqual({
        kind: "media",
      });
      expect(parseHlsPath(`${base}/init.mp4`, prefix)?.name).toEqual({
        kind: "init",
      });
      expect(parseHlsPath(`${base}/12.m4s`, prefix)?.name).toEqual({
        kind: "segment",
        index: 12,
      });
    });

    test(`rejects foreign paths under ${prefix}`, () => {
      const base = `${prefix}/session-1/item-2`;
      expect(parseHlsPath(`${base}/hls/evil.txt`, prefix)).toBeNull();
      expect(parseHlsPath(`${base}/master.m3u8`, prefix)).toBeNull();
      expect(parseHlsPath(`${base}/hls/`, prefix)).toBeNull();
      expect(parseHlsPath(`${base}/hls/01.m4s`, prefix)).toBeNull();
    });
  }

  test("does not cross prefixes", () => {
    expect(
      parseHlsPath("/api/playback/s/i/hls/master.m3u8", "/internal/playback"),
    ).toBeNull();
    expect(
      parseHlsPath("/internal/playback/s/i/hls/master.m3u8", "/api/playback"),
    ).toBeNull();
  });
});

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const { token } = await login(
    db,
    { username: "admin", password: "secret", ...device },
    "127.0.0.1",
  );
  const caller = await authenticate(db, token);
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
      bytes: 1_000n,
    })
    .returning();
  if (!version) throw new Error("Version insert returned no row.");
  return { admin, caller, item, version };
}

async function addSession(
  db: Database,
  userId: string,
  itemId: string,
  versionId: string,
  playMethod: "remux" | "direct-play",
) {
  const [session] = await db
    .insert(sessionRegistry)
    .values({ userId, itemId, versionId, playMethod, state: "starting" })
    .returning();
  if (!session) throw new Error("Session insert returned no row.");
  return session;
}

async function authCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  throw new Error("Expected an AuthError.");
}

describe.skipIf(!databaseUrl)("authorizeHlsRequest", () => {
  test("returns the caller and session for a valid token", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const session = await addSession(
        db,
        fx.admin.id,
        fx.item.id,
        fx.version.id,
        "remux",
      );
      const { token } = await issuePlaybackToken(db, fx.caller, {
        sessionId: session.id,
        itemId: fx.item.id,
      });
      const scope = { sessionId: session.id, itemId: fx.item.id };
      const url = new URL(
        `http://t/internal/playback/${session.id}/${fx.item.id}/hls/master.m3u8?token=${token}`,
      );
      const result = await authorizeHlsRequest(db, url, scope);
      expect(result.userId).toBe(fx.admin.id);
      expect(result.session).toMatchObject({
        userId: fx.admin.id,
        versionId: fx.version.id,
        playMethod: "remux",
        state: "starting",
        transcoderNodeId: null,
      });
    }));

  test("rejects a missing, empty or duplicated token", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const session = await addSession(
        db,
        fx.admin.id,
        fx.item.id,
        fx.version.id,
        "remux",
      );
      const { token } = await issuePlaybackToken(db, fx.caller, {
        sessionId: session.id,
        itemId: fx.item.id,
      });
      const scope = { sessionId: session.id, itemId: fx.item.id };
      const path = `http://t/internal/playback/${session.id}/${fx.item.id}/hls/master.m3u8`;
      for (const bad of [
        new URL(path),
        new URL(`${path}?token=`),
        new URL(`${path}?token=${token}&token=${token}`),
      ]) {
        expect(await authCode(authorizeHlsRequest(db, bad, scope))).toBe(
          "UNAUTHENTICATED",
        );
      }
    }));

  test("rejects a direct-play session", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const session = await addSession(
        db,
        fx.admin.id,
        fx.item.id,
        fx.version.id,
        "direct-play",
      );
      const { token } = await issuePlaybackToken(db, fx.caller, {
        sessionId: session.id,
        itemId: fx.item.id,
      });
      const scope = { sessionId: session.id, itemId: fx.item.id };
      const url = new URL(
        `http://t/internal/playback/${session.id}/${fx.item.id}/hls/master.m3u8?token=${token}`,
      );
      expect(await authCode(authorizeHlsRequest(db, url, scope))).toBe(
        "UNAUTHENTICATED",
      );
    }));

  test("rejects a stopped session", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const session = await addSession(
        db,
        fx.admin.id,
        fx.item.id,
        fx.version.id,
        "remux",
      );
      const { token } = await issuePlaybackToken(db, fx.caller, {
        sessionId: session.id,
        itemId: fx.item.id,
      });
      await db
        .update(sessionRegistry)
        .set({ state: "stopped" })
        .where(eq(sessionRegistry.id, session.id));
      const scope = { sessionId: session.id, itemId: fx.item.id };
      const url = new URL(
        `http://t/internal/playback/${session.id}/${fx.item.id}/hls/master.m3u8?token=${token}`,
      );
      expect(await authCode(authorizeHlsRequest(db, url, scope))).toBe(
        "UNAUTHENTICATED",
      );
    }));

  test("rejects a malformed scope", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const session = await addSession(
        db,
        fx.admin.id,
        fx.item.id,
        fx.version.id,
        "remux",
      );
      const { token } = await issuePlaybackToken(db, fx.caller, {
        sessionId: session.id,
        itemId: fx.item.id,
      });
      const url = new URL(
        `http://t/internal/playback/nope/${fx.item.id}/hls/master.m3u8?token=${token}`,
      );
      expect(
        await authCode(
          authorizeHlsRequest(db, url, {
            sessionId: "nope",
            itemId: fx.item.id,
          }),
        ),
      ).toBe("UNAUTHENTICATED");
    }));
});
