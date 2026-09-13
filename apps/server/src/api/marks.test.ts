import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { sessionCookieName } from "../auth/http.ts";
import { setPermissionOverride } from "../auth/permissions.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  items,
  libraries,
  libraryAccess,
  progress,
  sessionRegistry,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { encodeCursor } from "./pagination.ts";
import type { pendiaRouter } from "./router.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

function rpcClient(base: string, token?: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof pendiaRouter>>(link);
}

async function capture(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("Expected the client call to reject.");
}

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const owner = await createLocalUser(db, admin.id, {
    username: "owner",
    password: "owner-pass",
  });
  const { token: accountToken } = await login(
    db,
    { username: "owner", password: "owner-pass", ...device },
    "127.0.0.1",
  );
  const { token: keyToken } = await createApiKey(db, owner.id, "player");
  const other = await createLocalUser(db, admin.id, {
    username: "other",
    password: "other-pass",
  });
  const { token: otherToken } = await createApiKey(db, other.id, "other");
  return { admin, owner, other, accountToken, keyToken, otherToken };
}

async function addLibrary(db: Database, name: string) {
  const [library] = await db
    .insert(libraries)
    .values({ name, medium: "movies", rootPath: `/srv/${name}` })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

async function addItem(db: Database, libraryId: string, title: string) {
  const [item] = await db
    .insert(items)
    .values({
      libraryId,
      kind: "movie",
      title,
      canonicalFolder: title.toLowerCase(),
    })
    .returning();
  if (!item) throw new Error("Item insert returned no row.");
  return item;
}

async function addVersion(
  db: Database,
  libraryId: string,
  itemId: string,
  durationSeconds = 120,
) {
  const [version] = await db
    .insert(versions)
    .values({
      itemId,
      itemKind: "movie",
      libraryId,
      label: "Original",
      format: "video",
      bytes: 36n,
      durationSeconds,
    })
    .returning();
  if (!version) throw new Error("Version insert returned no row.");
  return version;
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
      state: "starting",
    })
    .returning();
  if (!session) throw new Error("Session insert returned no row.");
  return session;
}

async function addProgress(
  db: Database,
  row: {
    userId: string;
    itemId: string;
    versionId: string | null;
    positionSeconds: number;
    completed?: boolean;
    playedAt?: string;
    playCount?: number;
  },
) {
  await db.insert(progress).values({
    userId: row.userId,
    itemId: row.itemId,
    versionId: row.versionId,
    format: "video",
    positionSeconds: row.positionSeconds,
    completed: row.completed ?? false,
    playedAt:
      row.playedAt === undefined
        ? sql`clock_timestamp()`
        : sql`${row.playedAt}::timestamptz`,
    playCount: row.playCount ?? 1,
  });
}

async function setPlayedAt(
  db: Database,
  userId: string,
  itemId: string,
  stamp: string,
) {
  await db
    .update(progress)
    .set({ playedAt: sql`${stamp}::timestamptz` })
    .where(and(eq(progress.userId, userId), eq(progress.itemId, itemId)));
}

async function denyLibrary(
  db: Database,
  libraryId: string,
  userId: string,
  allowed: boolean,
) {
  await db.insert(libraryAccess).values({ libraryId, userId, allowed });
}

async function clearLibraryRules(
  db: Database,
  libraryId: string,
  userId: string,
) {
  await db
    .delete(libraryAccess)
    .where(
      and(
        eq(libraryAccess.libraryId, libraryId),
        eq(libraryAccess.userId, userId),
      ),
    );
}

describe.skipIf(!databaseUrl)("marks and shelves", () => {
  test("favourites and ratings toggle independently", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const library = await addLibrary(db, "movies");
      const item = await addItem(db, library.id, "Movie");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const get = () => client.marks.get({ itemId: item.id });
        const setFavourite = (favourite: boolean) =>
          client.marks.setFavourite({ itemId: item.id, favourite });
        const setRating = (rating: number | null) =>
          client.marks.setRating({ itemId: item.id, rating });

        expect(await get()).toEqual({ favourite: false, rating: null });
        await setFavourite(true);
        await setFavourite(true);
        expect(await get()).toEqual({ favourite: true, rating: null });
        await setFavourite(false);
        expect(await get()).toEqual({ favourite: false, rating: null });

        await setRating(8.5);
        await setRating(8.5);
        expect(await get()).toEqual({ favourite: false, rating: 8.5 });
        await setRating(0);
        expect(await get()).toEqual({ favourite: false, rating: 0 });
        await setRating(10);
        expect(await get()).toEqual({ favourite: false, rating: 10 });
        await setRating(null);
        expect(await get()).toEqual({ favourite: false, rating: null });
        await setRating(8.2);
        expect(await get()).toEqual({ favourite: false, rating: 8.2 });

        await setFavourite(true);
        expect(await get()).toEqual({ favourite: true, rating: 8.2 });
        await setRating(null);
        expect(await get()).toEqual({ favourite: true, rating: null });
      } finally {
        await server.stop();
      }
    }));

  test("marks isolate users, enforce view and reject invalid input", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const library = await addLibrary(db, "movies");
      const item = await addItem(db, library.id, "Movie");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const otherClient = rpcClient(base, fx.otherToken);
        await client.marks.setFavourite({ itemId: item.id, favourite: true });
        await client.marks.setRating({ itemId: item.id, rating: 7.5 });

        expect(await otherClient.marks.get({ itemId: item.id })).toEqual({
          favourite: false,
          rating: null,
        });
        await otherClient.marks.setFavourite({
          itemId: item.id,
          favourite: true,
        });
        await otherClient.marks.setRating({ itemId: item.id, rating: 3 });
        expect(await client.marks.get({ itemId: item.id })).toEqual({
          favourite: true,
          rating: 7.5,
        });

        expect(
          (await capture(client.marks.get({ itemId: Bun.randomUUIDv7() })))
            .status,
        ).toBe(404);

        await denyLibrary(db, library.id, fx.owner.id, false);
        expect(
          (await capture(client.marks.get({ itemId: item.id }))).status,
        ).toBe(403);
        expect(
          (
            await capture(
              client.marks.setFavourite({
                itemId: item.id,
                favourite: false,
              }),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await capture(
              client.marks.setRating({ itemId: item.id, rating: 5 }),
            )
          ).status,
        ).toBe(403);
        await clearLibraryRules(db, library.id, fx.owner.id);

        const anonymous = await capture(
          rpcClient(base).marks.get({ itemId: item.id }),
        );
        expect(anonymous.status).toBe(401);

        const foreignOrigin = await fetch(
          `${base}/api/items/${item.id}/favourite`,
          {
            method: "PUT",
            headers: {
              cookie: `${sessionCookieName}=${fx.accountToken}`,
              origin: "http://evil.test",
              "content-type": "application/json",
            },
            body: JSON.stringify({ favourite: false }),
          },
        );
        expect(foreignOrigin.status).toBe(403);

        const putRating = await fetch(`${base}/api/items/${item.id}/rating`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${fx.keyToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: 9 }),
        });
        expect(putRating.status).toBe(200);
        expect(await putRating.json()).toEqual(
          await client.marks.setRating({ itemId: item.id, rating: 9 }),
        );
        const getMarks = await fetch(`${base}/api/items/${item.id}/marks`, {
          headers: { authorization: `Bearer ${fx.keyToken}` },
        });
        expect(getMarks.status).toBe(200);
        expect(await getMarks.json()).toEqual(
          await client.marks.get({ itemId: item.id }),
        );

        for (const rating of [-0.1, 10.1, 8.55])
          expect(
            (await capture(client.marks.setRating({ itemId: item.id, rating })))
              .status,
          ).toBe(400);
        const badType = await fetch(`${base}/api/items/${item.id}/rating`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${fx.keyToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ rating: "high" }),
        });
        expect(badType.status).toBe(400);
        const badFavourite = await fetch(
          `${base}/api/items/${item.id}/favourite`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${fx.keyToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ favourite: "yes" }),
          },
        );
        expect(badFavourite.status).toBe(400);
      } finally {
        await server.stop();
      }
    }));

  test("continue watching lists only in-progress owned items newest first", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const library = await addLibrary(db, "movies");
      const denied = await addLibrary(db, "denied");
      const itemA = await addItem(db, library.id, "Alpha");
      const itemE = await addItem(db, library.id, "Echo");
      const itemB = await addItem(db, library.id, "Done");
      const itemC = await addItem(db, library.id, "Untouched");
      const itemD = await addItem(db, denied.id, "Denied");
      const versionA = await addVersion(db, library.id, itemA.id);
      const versionE = await addVersion(db, library.id, itemE.id);
      const versionB = await addVersion(db, library.id, itemB.id);
      const versionC = await addVersion(db, library.id, itemC.id);
      const versionD = await addVersion(db, denied.id, itemD.id);
      const sessionA = await addSession(db, fx.owner.id, itemA.id, versionA.id);
      const sessionE = await addSession(db, fx.owner.id, itemE.id, versionE.id);
      const sessionB = await addSession(db, fx.owner.id, itemB.id, versionB.id);
      const sessionC = await addSession(db, fx.owner.id, itemC.id, versionC.id);
      await addProgress(db, {
        userId: fx.other.id,
        itemId: itemA.id,
        versionId: versionA.id,
        positionSeconds: 99,
      });
      await addProgress(db, {
        userId: fx.owner.id,
        itemId: itemD.id,
        versionId: versionD.id,
        positionSeconds: 50,
      });
      await denyLibrary(db, denied.id, fx.owner.id, false);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const watch = async (
          sessionId: string,
          itemId: string,
          position: number,
          completed?: boolean,
        ) => {
          await client.playback.start({
            sessionId,
            itemId,
            positionSeconds: 0,
          });
          await client.playback.progress({
            sessionId,
            itemId,
            positionSeconds: position,
            completed,
          });
        };
        await watch(sessionA.id, itemA.id, 42.5);
        await watch(sessionE.id, itemE.id, 10);
        await watch(sessionB.id, itemB.id, 120, true);
        await client.playback.start({
          sessionId: sessionC.id,
          itemId: itemC.id,
          positionSeconds: 0,
        });

        await setPlayedAt(db, fx.owner.id, itemA.id, "2026-01-01T00:00:01Z");
        await setPlayedAt(db, fx.owner.id, itemE.id, "2026-01-01T00:00:02Z");
        await setPlayedAt(db, fx.owner.id, itemB.id, "2026-01-02T00:00:00Z");
        await setPlayedAt(db, fx.owner.id, itemD.id, "2026-01-02T00:00:00Z");

        const shelf = await client.shelves.continueWatching({});
        expect(shelf.cursor).toBeNull();
        expect(shelf.items.map((entry) => entry.item.id)).toEqual([
          itemE.id,
          itemA.id,
        ]);
        expect(shelf.items[0]).toMatchObject({
          item: { id: itemE.id, libraryId: library.id },
          progress: {
            userId: fx.owner.id,
            versionId: versionE.id,
            format: "video",
            positionSeconds: 10,
            completed: false,
          },
          durationSeconds: 120,
        });
        expect(shelf.items[1]).toMatchObject({
          progress: { positionSeconds: 42.5 },
          durationSeconds: 120,
        });
      } finally {
        await server.stop();
      }
    }));

  test("continue watching paginates microsecond ties and live permission changes", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const library = await addLibrary(db, "movies");
      const denied = await addLibrary(db, "denied");
      const late = await addLibrary(db, "late");
      const oldest = await addItem(db, library.id, "Oldest");
      const tiedA = await addItem(db, library.id, "Tied A");
      const tiedB = await addItem(db, library.id, "Tied B");
      const deniedItem = await addItem(db, denied.id, "Denied");
      const lateItem = await addItem(db, late.id, "Late");
      for (const item of [oldest, tiedA, tiedB, deniedItem, lateItem]) {
        const version = await addVersion(db, item.libraryId, item.id);
        await addProgress(db, {
          userId: fx.owner.id,
          itemId: item.id,
          versionId: version.id,
          positionSeconds: 10,
        });
      }
      await setPlayedAt(
        db,
        fx.owner.id,
        oldest.id,
        "2026-01-01T00:00:00.123456Z",
      );
      await setPlayedAt(
        db,
        fx.owner.id,
        tiedA.id,
        "2026-01-01T00:00:00.123789Z",
      );
      await setPlayedAt(
        db,
        fx.owner.id,
        tiedB.id,
        "2026-01-01T00:00:00.123789Z",
      );
      await setPlayedAt(
        db,
        fx.owner.id,
        deniedItem.id,
        "2026-01-02T00:00:00.999999Z",
      );
      await setPlayedAt(
        db,
        fx.owner.id,
        lateItem.id,
        "2026-01-01T00:00:00.000001Z",
      );
      await denyLibrary(db, denied.id, fx.owner.id, false);
      await denyLibrary(db, late.id, fx.owner.id, false);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const visited: string[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await client.shelves.continueWatching({
            limit: 1,
            cursor,
          });
          for (const entry of page.items) visited.push(entry.item.id);
          if (page.cursor === null) break;
          cursor = page.cursor;
        }
        const tiedFirst = tiedA.id > tiedB.id ? tiedA.id : tiedB.id;
        const tiedSecond = tiedA.id > tiedB.id ? tiedB.id : tiedA.id;
        expect(visited).toEqual([tiedFirst, tiedSecond, oldest.id]);

        await clearLibraryRules(db, late.id, fx.owner.id);
        const p1 = await client.shelves.continueWatching({ limit: 1 });
        expect(p1.items.map((entry) => entry.item.id)).toEqual([tiedFirst]);
        if (p1.cursor === null) throw new Error("Expected a cursor.");
        await denyLibrary(db, late.id, fx.owner.id, false);
        const p2 = await client.shelves.continueWatching({
          limit: 1,
          cursor: p1.cursor,
        });
        expect(p2.items.map((entry) => entry.item.id)).toEqual([tiedSecond]);
        if (p2.cursor === null) throw new Error("Expected a cursor.");
        const p3 = await client.shelves.continueWatching({
          limit: 1,
          cursor: p2.cursor,
        });
        expect(p3.items.map((entry) => entry.item.id)).toEqual([oldest.id]);
        expect(p3.cursor).toBeNull();

        for (const bad of [
          "not-a-cursor",
          "cw1.not-base64!!!",
          encodeCursor({ addedAt: "2026-01-01T00:00:00.000Z", id: oldest.id }),
        ])
          expect(
            (await capture(client.shelves.continueWatching({ cursor: bad })))
              .status,
          ).toBe(400);

        const nobody = await createLocalUser(db, fx.admin.id, {
          username: "nobody",
          password: "nobody-pass",
        });
        const { token: nobodyToken } = await createApiKey(
          db,
          nobody.id,
          "none",
        );
        const nobodyVersion = await addVersion(db, denied.id, deniedItem.id);
        await addProgress(db, {
          userId: nobody.id,
          itemId: deniedItem.id,
          versionId: nobodyVersion.id,
          positionSeconds: 5,
        });
        await setPermissionOverride(db, fx.admin.id, nobody.id, "view", false);
        const nobodyClient = rpcClient(base, nobodyToken);
        expect(await nobodyClient.shelves.continueWatching({})).toEqual({
          items: [],
          cursor: null,
        });
        const [oldestVersion] = await db
          .select({ id: versions.id })
          .from(versions)
          .where(eq(versions.itemId, oldest.id))
          .limit(1);
        if (!oldestVersion) throw new Error("Expected a version row.");
        await addProgress(db, {
          userId: nobody.id,
          itemId: oldest.id,
          versionId: oldestVersion.id,
          positionSeconds: 5,
        });
        await db.insert(libraryAccess).values({
          libraryId: library.id,
          userId: nobody.id,
          allowed: true,
        });
        const partial = await nobodyClient.shelves.continueWatching({});
        expect(partial.cursor).toBeNull();
        expect(partial.items.map((entry) => entry.item.id)).toEqual([
          oldest.id,
        ]);
      } finally {
        await server.stop();
      }
    }));

  test("deleted versions stay on the shelf with null duration", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const library = await addLibrary(db, "movies");
      const item = await addItem(db, library.id, "Movie");
      const version = await addVersion(db, library.id, item.id);
      await addProgress(db, {
        userId: fx.owner.id,
        itemId: item.id,
        versionId: version.id,
        positionSeconds: 10,
      });
      await db.delete(versions).where(eq(versions.id, version.id));
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const shelf = await client.shelves.continueWatching({});
        expect(shelf.items).toHaveLength(1);
        expect(shelf.items[0]).toMatchObject({
          item: { id: item.id },
          progress: { versionId: null, positionSeconds: 10 },
          durationSeconds: null,
        });
        const rest = await fetch(`${base}/api/shelves/continue-watching`, {
          headers: { authorization: `Bearer ${fx.keyToken}` },
        });
        expect(rest.status).toBe(200);
        expect(await rest.json()).toEqual(shelf);
      } finally {
        await server.stop();
      }
    }));
});
