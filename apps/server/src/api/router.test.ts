import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { setPermissionOverride } from "../auth/permissions.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
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
    password: "admin-pass",
  });
  const { token } = await login(
    db,
    { username: "admin", password: "admin-pass", ...device },
    "127.0.0.1",
  );
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: "/srv/movies" })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  const rows = [];
  for (const index of [0, 1, 2, 3, 4]) {
    const [row] = await db
      .insert(items)
      .values({
        libraryId: library.id,
        kind: "movie",
        title: `Movie ${index}`,
        canonicalFolder: `/srv/movies/movie-${index}`,
        addedAt: new Date(Date.UTC(2026, 0, 10, 0, 0, index)),
      })
      .returning();
    if (!row) throw new Error("Item insert returned no row.");
    rows.push(row);
  }
  return { admin, token, library, rows };
}

describe.skipIf(!databaseUrl)("api router", () => {
  test("the same procedure answers identically over RPC and REST", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const viaRpc = await rpcClient(base, token).items.list({ limit: 2 });
        const rest = await fetch(`${base}/api/items?limit=2`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(rest.status).toBe(200);
        expect(await rest.json()).toEqual(viaRpc);
      } finally {
        await server.stop();
      }
    }));

  test("the list pages newest first through the cursor", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token, rows } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, token);
        const seen: string[] = [];
        const pageSizes: number[] = [];
        let cursor: string | null = null;
        for (;;) {
          const page = await client.items.list(
            cursor === null ? { limit: 2 } : { limit: 2, cursor },
          );
          seen.push(...page.items.map((item) => item.id));
          pageSizes.push(page.items.length);
          if (page.cursor === null) break;
          cursor = page.cursor;
        }
        expect(pageSizes).toEqual([2, 2, 1]);
        expect(new Set(seen).size).toBe(rows.length);
        expect(seen).toEqual(rows.map((row) => row.id).reverse());
      } finally {
        await server.stop();
      }
    }));

  test("an unauthenticated call answers 401 on both transports", () =>
    withDatabase(async (_db, url) => {
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        expect((await fetch(`${base}/api/items`)).status).toBe(401);
        const error = await capture(rpcClient(base).items.list({}));
        expect(error.code).toBe("UNAUTHORIZED");
        expect(error.status).toBe(401);
      } finally {
        await server.stop();
      }
    }));

  test("a caller denied the view permission answers 403", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      await setPermissionOverride(db, admin.id, viewer.id, "view", false);
      const { token } = await createApiKey(db, viewer.id, "viewer-key");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const rest = await fetch(`${base}/api/items`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(rest.status).toBe(403);
        const error = await capture(rpcClient(base, token).items.list({}));
        expect(error.code).toBe("FORBIDDEN");
        expect(error.status).toBe(403);
      } finally {
        await server.stop();
      }
    }));

  test("me answers the caller for a session token and an API key", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token } = await seed(db);
      const { token: keyToken, key } = await createApiKey(db, admin.id, "bot");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const viaSession = await rpcClient(base, token).me();
        expect(viaSession.user).toMatchObject({
          id: admin.id,
          username: "admin",
        });
        expect(viaSession.credential.kind).toBe("session");
        const viaKey = await rpcClient(base, keyToken).me();
        expect(viaKey.user.id).toBe(admin.id);
        expect(viaKey.credential).toEqual({ kind: "api-key", id: key.id });
      } finally {
        await server.stop();
      }
    }));

  test("an unknown item answers 404 and a garbage cursor answers 400", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = rpcClient(base, token);
        const missing = Bun.randomUUIDv7();

        const restGet = await fetch(`${base}/api/items/${missing}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(restGet.status).toBe(404);
        const notFound = await capture(client.items.get({ id: missing }));
        expect(notFound.code).toBe("NOT_FOUND");
        expect(notFound.status).toBe(404);

        const restList = await fetch(`${base}/api/items?cursor=not-a-cursor`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(restList.status).toBe(400);
        const badCursor = await capture(
          client.items.list({ cursor: "not-a-cursor" }),
        );
        expect(badCursor.code).toBe("BAD_REQUEST");
        expect(badCursor.status).toBe(400);
      } finally {
        await server.stop();
      }
    }));
});
