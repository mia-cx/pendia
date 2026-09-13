import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, asc, eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { setPermissionOverride } from "../auth/permissions.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  events,
  items,
  libraries,
  libraryAccess,
  progress,
  segmentTimelines,
  sessionRegistry,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import type { pendiaRouter } from "./router.ts";

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
  const { token: keyToken } = await createApiKey(db, owner.id, "player");
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
      canonicalFolder: "movie",
    })
    .returning();
  if (!item) throw new Error("Item insert returned no row.");
  return { admin, owner, keyToken, library, item };
}

async function addVersion(
  db: Database,
  fx: { library: { id: string }; item: { id: string } },
  options: { timelineId?: string; duration?: number } = {},
) {
  const [version] = await db
    .insert(versions)
    .values({
      itemId: fx.item.id,
      itemKind: "movie",
      libraryId: fx.library.id,
      label: "Original",
      format: "video",
      bytes: 36n,
      durationSeconds: options.duration ?? 120,
      segmentTimelineId: options.timelineId ?? null,
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
  state: "queued" | "starting" | "playing" | "stopped" = "starting",
) {
  const [session] = await db
    .insert(sessionRegistry)
    .values({ userId, itemId, versionId, playMethod: "direct-play", state })
    .returning();
  if (!session) throw new Error("Session insert returned no row.");
  return session;
}

describe.skipIf(!databaseUrl)("playback progress", () => {
  test("start, heartbeat and stop write item progress once", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const version = await addVersion(db, fx);
      const session = await addSession(db, fx.owner.id, fx.item.id, version.id);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const started = await client.playback.start({
          sessionId: session.id,
          itemId: fx.item.id,
          positionSeconds: 0,
        });
        expect(started.state).toBe("playing");
        expect(started.progress).toMatchObject({
          userId: fx.owner.id,
          itemId: fx.item.id,
          versionId: version.id,
          format: "video",
          positionSeconds: 0,
          completed: false,
          playCount: 1,
        });
        expect(started.progress?.playedAt).not.toBeNull();
        expect(started.progress?.updatedAt).not.toBeNull();

        const beat = await client.playback.progress({
          sessionId: session.id,
          itemId: fx.item.id,
          positionSeconds: 42.5,
        });
        expect(beat.state).toBe("playing");
        expect(beat.progress).toMatchObject({
          positionSeconds: 42.5,
          playCount: 1,
          completed: false,
        });

        const again = await client.playback.start({
          sessionId: session.id,
          itemId: fx.item.id,
        });
        expect(again.state).toBe("playing");
        expect(again.progress).toMatchObject({
          positionSeconds: 42.5,
          playCount: 1,
        });

        const read = await client.playback.getProgress({ itemId: fx.item.id });
        expect(read).toMatchObject({
          positionSeconds: 42.5,
          playCount: 1,
          versionId: version.id,
        });

        const stopped = await client.playback.stop({
          sessionId: session.id,
          itemId: fx.item.id,
          positionSeconds: 43.5,
        });
        expect(stopped.state).toBe("stopped");
        expect(stopped.progress).toMatchObject({
          positionSeconds: 43.5,
          playCount: 1,
        });

        const repeated = await client.playback.stop({
          sessionId: session.id,
          itemId: fx.item.id,
          positionSeconds: 999,
        });
        expect(repeated.state).toBe("stopped");
        expect(repeated.progress).toMatchObject({
          positionSeconds: 43.5,
          playCount: 1,
        });

        const restart = await capture(
          client.playback.start({
            sessionId: session.id,
            itemId: fx.item.id,
          }),
        );
        expect(restart.status).toBe(409);
        const lateBeat = await capture(
          client.playback.progress({
            sessionId: session.id,
            itemId: fx.item.id,
            positionSeconds: 50,
          }),
        );
        expect(lateBeat.status).toBe(409);
      } finally {
        await server.stop();
      }
    }));

  test("resume follows compatible versions through shared timelines only", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const [first] = await db
        .insert(segmentTimelines)
        .values({
          itemId: fx.item.id,
          cutKey: "cut-a",
          boundariesSeconds: [0, 4, 8, 120],
        })
        .returning();
      const [second] = await db
        .insert(segmentTimelines)
        .values({
          itemId: fx.item.id,
          cutKey: "cut-b",
          boundariesSeconds: [0, 4, 8, 120],
        })
        .returning();
      if (!first || !second)
        throw new Error("Timeline insert returned no row.");
      const versionA = await addVersion(db, fx, { timelineId: first.id });
      const versionB = await addVersion(db, fx, { timelineId: first.id });
      const versionC = await addVersion(db, fx, { timelineId: second.id });
      const versionD = await addVersion(db, fx);
      const versionE = await addVersion(db, fx);
      const sessionA = await addSession(
        db,
        fx.owner.id,
        fx.item.id,
        versionA.id,
      );
      const sessionB = await addSession(
        db,
        fx.owner.id,
        fx.item.id,
        versionB.id,
      );
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const resume = (versionId: string) =>
          client.playback.resume({ itemId: fx.item.id, versionId });
        await client.playback.start({
          sessionId: sessionA.id,
          itemId: fx.item.id,
          positionSeconds: 0,
        });
        await client.playback.progress({
          sessionId: sessionA.id,
          itemId: fx.item.id,
          positionSeconds: 42.5,
        });
        expect(
          await client.playback.getProgress({ itemId: fx.item.id }),
        ).toMatchObject({
          versionId: versionA.id,
          format: "video",
          positionSeconds: 42.5,
          playCount: 1,
        });
        expect((await resume(versionB.id)).positionSeconds).toBe(42.5);
        expect((await resume(versionC.id)).positionSeconds).toBe(0);
        expect((await resume(versionA.id)).positionSeconds).toBe(42.5);

        const resumed = await client.playback.start({
          sessionId: sessionB.id,
          itemId: fx.item.id,
        });
        expect(resumed.progress).toMatchObject({
          positionSeconds: 42.5,
          versionId: versionB.id,
          format: "video",
          playCount: 2,
        });
        await client.playback.stop({
          sessionId: sessionB.id,
          itemId: fx.item.id,
          positionSeconds: 42.5,
        });

        await db
          .update(progress)
          .set({ versionId: versionA.id, positionSeconds: 150 })
          .where(eq(progress.userId, fx.owner.id));
        expect((await resume(versionA.id)).positionSeconds).toBe(120);

        await db
          .update(progress)
          .set({ versionId: versionD.id, positionSeconds: 42.5 })
          .where(eq(progress.userId, fx.owner.id));
        expect((await resume(versionE.id)).positionSeconds).toBe(0);
        expect((await resume(versionD.id)).positionSeconds).toBe(42.5);

        await db.delete(versions).where(eq(versions.id, versionD.id));
        expect((await resume(versionB.id)).positionSeconds).toBe(0);
      } finally {
        await server.stop();
      }
    }));

  test("stopping a starting session cancels without writing progress", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const version = await addVersion(db, fx);
      const session = await addSession(db, fx.owner.id, fx.item.id, version.id);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const scope = { sessionId: session.id, itemId: fx.item.id };
        const cancelled = await client.playback.stop({
          ...scope,
          positionSeconds: 10,
        });
        expect(cancelled.state).toBe("stopped");
        expect(cancelled.progress).toBeNull();
        expect(
          await client.playback.getProgress({ itemId: fx.item.id }),
        ).toBeNull();
        expect((await capture(client.playback.start(scope))).status).toBe(409);
        const repeated = await client.playback.stop({
          ...scope,
          positionSeconds: 20,
        });
        expect(repeated.state).toBe("stopped");
        expect(repeated.progress).toBeNull();
        expect(
          await client.playback.getProgress({ itemId: fx.item.id }),
        ).toBeNull();
      } finally {
        await server.stop();
      }
    }));

  test("completed items resume at zero and a new start replays cleanly", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const version = await addVersion(db, fx);
      const first = await addSession(db, fx.owner.id, fx.item.id, version.id);
      const second = await addSession(db, fx.owner.id, fx.item.id, version.id);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        await client.playback.start({
          sessionId: first.id,
          itemId: fx.item.id,
          positionSeconds: 0,
        });
        await client.playback.progress({
          sessionId: first.id,
          itemId: fx.item.id,
          positionSeconds: 120,
          completed: true,
        });
        const read = await client.playback.getProgress({ itemId: fx.item.id });
        expect(read).toMatchObject({
          positionSeconds: 120,
          completed: true,
          playCount: 1,
        });
        const resumed = await client.playback.resume({
          itemId: fx.item.id,
          versionId: version.id,
        });
        expect(resumed.positionSeconds).toBe(0);
        const replay = await client.playback.start({
          sessionId: second.id,
          itemId: fx.item.id,
        });
        expect(replay.progress).toMatchObject({
          positionSeconds: 0,
          completed: false,
          playCount: 2,
        });
      } finally {
        await server.stop();
      }
    }));

  test("isolates users, enforces permissions and validates boundaries", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const other = await createLocalUser(db, fx.admin.id, {
        username: "other",
        password: "other-pass",
      });
      const { token: otherToken } = await createApiKey(db, other.id, "other");
      const version = await addVersion(db, fx);
      const session = await addSession(db, fx.owner.id, fx.item.id, version.id);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const otherClient = rpcClient(base, otherToken);
        const scope = { sessionId: session.id, itemId: fx.item.id };

        expect(
          await otherClient.playback.getProgress({ itemId: fx.item.id }),
        ).toBeNull();
        expect((await capture(otherClient.playback.start(scope))).status).toBe(
          401,
        );
        expect(
          (
            await capture(
              otherClient.playback.progress({
                ...scope,
                positionSeconds: 1,
              }),
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await capture(
              otherClient.playback.stop({ ...scope, positionSeconds: 1 }),
            )
          ).status,
        ).toBe(401);

        await db.insert(libraryAccess).values({
          libraryId: fx.library.id,
          userId: fx.owner.id,
          allowed: false,
        });
        expect((await capture(client.playback.start(scope))).status).toBe(403);
        await db
          .delete(libraryAccess)
          .where(
            and(
              eq(libraryAccess.userId, fx.owner.id),
              eq(libraryAccess.libraryId, fx.library.id),
            ),
          );
        await setPermissionOverride(
          db,
          fx.admin.id,
          fx.owner.id,
          "play",
          false,
        );
        expect((await capture(client.playback.start(scope))).status).toBe(403);
        await setPermissionOverride(db, fx.admin.id, fx.owner.id, "play", null);

        expect(
          (
            await capture(
              client.playback.getProgress({ itemId: Bun.randomUUIDv7() }),
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await capture(
              client.playback.resume({
                itemId: fx.item.id,
                versionId: Bun.randomUUIDv7(),
              }),
            )
          ).status,
        ).toBe(404);

        expect(
          (
            await capture(
              client.playback.start({ ...scope, positionSeconds: -1 }),
            )
          ).status,
        ).toBe(400);
        await client.playback.start({ ...scope, positionSeconds: 0 });
        expect(
          (
            await capture(
              client.playback.progress({ ...scope, positionSeconds: 999 }),
            )
          ).status,
        ).toBe(400);

        const rest = await fetch(
          `${base}/api/playback/${session.id}/${fx.item.id}/progress`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${fx.keyToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ positionSeconds: 50 }),
          },
        );
        expect(rest.status).toBe(200);
        const restBody = (await rest.json()) as {
          state: string;
          progress: Record<string, unknown> | null;
        };
        expect(restBody.state).toBe("playing");
        expect(restBody.progress).toMatchObject({
          userId: fx.owner.id,
          itemId: fx.item.id,
          versionId: version.id,
          format: "video",
          positionSeconds: 50,
          completed: false,
          playCount: 1,
        });
        const restRead = await fetch(
          `${base}/api/items/${fx.item.id}/progress`,
          { headers: { authorization: `Bearer ${fx.keyToken}` } },
        );
        expect(restRead.status).toBe(200);
        const restProgress: unknown = await restRead.json();
        const rpcRead = await client.playback.getProgress({
          itemId: fx.item.id,
        });
        expect(restProgress).toEqual(rpcRead);
      } finally {
        await server.stop();
      }
    }));

  test("concurrent and late lifecycle calls stay serialized per item", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      const version = await addVersion(db, fx);
      const sessionA = await addSession(
        db,
        fx.owner.id,
        fx.item.id,
        version.id,
      );
      const sessionB = await addSession(
        db,
        fx.owner.id,
        fx.item.id,
        version.id,
      );
      const sessionC = await addSession(
        db,
        fx.owner.id,
        fx.item.id,
        version.id,
      );
      const [item2] = await db
        .insert(items)
        .values({
          libraryId: fx.library.id,
          kind: "movie",
          title: "Second",
          canonicalFolder: "second",
        })
        .returning();
      if (!item2) throw new Error("Item insert returned no row.");
      const version2 = await addVersion(db, {
        library: fx.library,
        item: item2,
      });
      const sessionD = await addSession(db, fx.owner.id, item2.id, version2.id);
      const sessionE = await addSession(db, fx.owner.id, item2.id, version2.id);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, fx.keyToken);
        const scopeA = { sessionId: sessionA.id, itemId: fx.item.id };
        const scopeB = { sessionId: sessionB.id, itemId: fx.item.id };
        const scopeC = { sessionId: sessionC.id, itemId: fx.item.id };

        await client.playback.start({ ...scopeA, positionSeconds: 0 });
        await client.playback.progress({ ...scopeA, positionSeconds: 30 });
        await client.playback.stop({ ...scopeA, positionSeconds: 30 });

        await client.playback.start({ ...scopeB, positionSeconds: 0 });
        await client.playback.progress({ ...scopeB, positionSeconds: 50 });

        const lateStop = await client.playback.stop({
          ...scopeA,
          positionSeconds: 999,
        });
        expect(lateStop.state).toBe("stopped");
        expect(lateStop.progress).toMatchObject({
          positionSeconds: 50,
          playCount: 2,
        });

        const [left, right] = await Promise.all([
          client.playback.start({ ...scopeC, positionSeconds: 0 }),
          client.playback.start({ ...scopeC, positionSeconds: 0 }),
        ]);
        expect(left.state).toBe("playing");
        expect(right.state).toBe("playing");
        const read = await client.playback.getProgress({ itemId: fx.item.id });
        expect(read).toMatchObject({ positionSeconds: 0, playCount: 3 });

        const [raceD, raceE] = await Promise.all([
          client.playback.start({
            sessionId: sessionD.id,
            itemId: item2.id,
            positionSeconds: 0,
          }),
          client.playback.start({
            sessionId: sessionE.id,
            itemId: item2.id,
            positionSeconds: 0,
          }),
        ]);
        expect(raceD.state).toBe("playing");
        expect(raceE.state).toBe("playing");
        expect(
          await client.playback.getProgress({ itemId: item2.id }),
        ).toMatchObject({ playCount: 2 });

        const sessionEvents = (
          await db
            .select({ payload: events.payload })
            .from(events)
            .where(eq(events.kind, "session.state"))
            .orderBy(asc(events.id))
        ).map((row) => row.payload);
        expect(
          sessionEvents
            .filter((event) => event.sessionId === sessionA.id)
            .map((event) => event.state),
        ).toEqual(["playing", "stopped"]);
        expect(
          sessionEvents
            .filter((event) => event.sessionId === sessionC.id)
            .map((event) => event.state),
        ).toEqual(["playing"]);
      } finally {
        await server.stop();
      }
    }));
});
