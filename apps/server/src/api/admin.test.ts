import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { eq } from "drizzle-orm";
import { createPendiaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { checkPermission, createGroup } from "../auth/permissions.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { groups, libraries, settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { setProviderKey } from "../providers/keys.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

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
  return { admin, token };
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

describe.skipIf(!databaseUrl)("admin api", () => {
  test("setup.status answers before and after the first admin", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createPendiaClient({ origin: base });
        expect(await client.setup.status()).toEqual({ complete: false });
        const rest = await fetch(`${base}/api/setup/status`);
        expect(rest.status).toBe(200);
        expect(await rest.json()).toEqual({ complete: false });
        await setupAdmin(db, { username: "admin", password: "admin-pass" });
        expect(await client.setup.status()).toEqual({ complete: true });
      } finally {
        await server.stop();
      }
    }));

  test("admin procedures reject missing and powerless credentials", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token: viewerToken } = await createApiKey(
        db,
        viewer.id,
        "viewer-key",
      );
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        for (const path of ["/api/users", "/api/groups", "/api/settings"])
          expect((await fetch(`${base}${path}`)).status).toBe(401);
        const viewerClient = createPendiaClient({
          origin: base,
          headers: { authorization: `Bearer ${viewerToken}` },
        });
        for (const denied of [
          () => viewerClient.users.list(),
          () => viewerClient.groups.list(),
          () => viewerClient.settings.get(),
          () =>
            viewerClient.users.setSettings({
              id: viewer.id,
              bitrateCapBps: null,
              contentRatingCeiling: null,
            }),
          () =>
            viewerClient.groups.setPermissions({
              id: Bun.randomUUIDv7(),
              permissions: [],
            }),
        ]) {
          const error = await capture(denied());
          expect(error.code).toBe("FORBIDDEN");
          expect(error.status).toBe(403);
        }
        const rest = await fetch(`${base}/api/users`, {
          headers: { authorization: `Bearer ${viewerToken}` },
        });
        expect(rest.status).toBe(403);
      } finally {
        await server.stop();
      }
    }));

  test("users.create, list and get answer over RPC and REST", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const headers = { authorization: `Bearer ${token}` };
        const client = createPendiaClient({ origin: base, headers });
        const created = await client.users.create({
          username: " Alice ",
          password: "alice-pass",
          displayName: " Alice A. ",
        });
        expect(created).toEqual({
          id: created.id,
          username: "alice",
          displayName: "Alice A.",
        });
        const listed = await client.users.list();
        expect(listed.map((user) => user.username)).toEqual(["admin", "alice"]);
        expect(listed[1]).toMatchObject({
          email: null,
          disabledAt: null,
        });
        const access = await client.users.get({ id: created.id });
        const [usersGroup] = await db
          .select()
          .from(groups)
          .where(eq(groups.name, "users"));
        if (!usersGroup) throw new Error("Seed group missing.");
        expect(access.user.username).toBe("alice");
        expect(access.groupIds).toEqual([usersGroup.id]);
        expect(access.overrides).toEqual([]);
        expect(access.libraryAccess).toEqual([]);
        expect(access.settings).toEqual({
          bitrateCapBps: null,
          contentRatingCeiling: null,
        });
        const restGet = await fetch(`${base}/api/users/${created.id}`, {
          headers,
        });
        expect(restGet.status).toBe(200);
        expect(await restGet.json()).toEqual(access);
        expect(
          (await fetch(`${base}/api/users/not-a-uuid`, { headers })).status,
        ).toBe(400);
        expect(
          (
            await fetch(`${base}/api/users/${Bun.randomUUIDv7()}`, {
              headers,
            })
          ).status,
        ).toBe(404);
        const notFound = await capture(
          client.users.get({ id: Bun.randomUUIDv7() }),
        );
        expect(notFound.code).toBe("NOT_FOUND");
      } finally {
        await server.stop();
      }
    }));

  test("users.setSettings round trips a cap above 2^31 and clears", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createPendiaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const cap = 40_000_000_000;
        const updated = await client.users.setSettings({
          id: viewer.id,
          bitrateCapBps: cap,
          contentRatingCeiling: " PG-13 ",
        });
        expect(updated.settings).toEqual({
          bitrateCapBps: cap,
          contentRatingCeiling: "PG-13",
        });
        const cleared = await client.users.setSettings({
          id: viewer.id,
          bitrateCapBps: null,
          contentRatingCeiling: null,
        });
        expect(cleared.settings).toEqual({
          bitrateCapBps: null,
          contentRatingCeiling: null,
        });
      } finally {
        await server.stop();
      }
    }));

  test("users.setGroups and setOverride refresh the access shape", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const custom = await createGroup(db, admin.id, {
        name: "editors",
        permissions: ["manage-metadata"],
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createPendiaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const grouped = await client.users.setGroups({
          id: viewer.id,
          groupIds: [custom.id],
        });
        expect(grouped.groupIds).toEqual([custom.id]);
        const overridden = await client.users.setOverride({
          id: viewer.id,
          permission: "play",
          allowed: false,
        });
        expect(overridden.overrides).toEqual([
          { permission: "play", allowed: false },
        ]);
        const inherited = await client.users.setOverride({
          id: viewer.id,
          permission: "play",
          allowed: null,
        });
        expect(inherited.overrides).toEqual([]);
        const conflict = await fetch(`${base}/api/users/${admin.id}/groups`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ groupIds: [] }),
        });
        expect(conflict.status).toBe(409);
      } finally {
        await server.stop();
      }
    }));

  test("users.sessions lists and users.revokeSession revokes", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { session } = await login(
        db,
        { username: "viewer", password: "viewer-pass", ...device },
        "127.0.0.1",
      );
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createPendiaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const listed = await client.users.sessions({ id: viewer.id });
        const found = listed.find((row) => row.id === session.id);
        expect(found).toMatchObject({
          clientName: "Test Client",
          deviceId: "device-1",
          revokedAt: null,
        });
        expect(typeof found?.createdAt).toBe("string");
        expect(await client.users.revokeSession({ id: session.id })).toEqual({
          ok: true,
        });
        const relisted = await client.users.sessions({ id: viewer.id });
        expect(
          relisted.find((row) => row.id === session.id)?.revokedAt,
        ).not.toBeNull();
      } finally {
        await server.stop();
      }
    }));

  test("users.setLibraryAccess denies then inherits through UserAccess", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const [library] = await db
        .insert(libraries)
        .values({ name: "Movies", medium: "movies", rootPath: "/srv/movies" })
        .returning();
      if (!library) throw new Error("Library insert returned no row.");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createPendiaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const denied = await client.users.setLibraryAccess({
          id: viewer.id,
          libraryId: library.id,
          allowed: false,
        });
        expect(denied.libraryAccess).toEqual([
          { libraryId: library.id, allowed: false },
        ]);
        expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
          false,
        );
        const inherited = await client.users.setLibraryAccess({
          id: viewer.id,
          libraryId: library.id,
          allowed: null,
        });
        expect(inherited.libraryAccess).toEqual([]);
        expect(await checkPermission(db, viewer.id, "view", library.id)).toBe(
          true,
        );
      } finally {
        await server.stop();
      }
    }));

  test("groups.create and setPermissions edit custom groups only", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const headers = { authorization: `Bearer ${token}` };
        const client = createPendiaClient({ origin: base, headers });
        const created = await client.groups.create({
          name: "editors",
          permissions: ["manage-metadata"],
        });
        expect(created).toMatchObject({
          name: "editors",
          builtIn: false,
          permissions: ["manage-metadata"],
        });
        const updated = await client.groups.setPermissions({
          id: created.id,
          permissions: ["view", "manage-subtitles"],
        });
        expect(updated.permissions).toEqual(["view", "manage-subtitles"]);
        const [admins] = await db
          .select()
          .from(groups)
          .where(eq(groups.name, "admins"));
        if (!admins) throw new Error("Seed group missing.");
        const builtIn = await fetch(
          `${base}/api/groups/${admins.id}/permissions`,
          {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ permissions: ["view"] }),
          },
        );
        expect(builtIn.status).toBe(400);
      } finally {
        await server.stop();
      }
    }));

  test("settings.get reports configuration without any secret", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token } = await seed(db);
      await db.insert(settings).values({
        key: "auth",
        value: {
          oidc: {
            issuer: "https://id.mia.cx/application/o/pendia",
            clientId: "pendia",
            clientSecret: "oidc-secret-value",
            scopes: ["openid"],
          },
        },
      });
      await setProviderKey(db, admin.id, "tmdb", "provider-secret-value");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const headers = { authorization: `Bearer ${token}` };
        const rest = await fetch(`${base}/api/settings`, { headers });
        expect(rest.status).toBe(200);
        const text = await rest.text();
        expect(text).not.toContain("oidc-secret-value");
        expect(text).not.toContain("provider-secret-value");
        expect(JSON.parse(text)).toEqual({
          trustedProxyAddresses: [],
          artworkRequiresAuth: false,
          oidcConfigured: true,
          providerKeys: ["tmdb"],
        });
        const client = createPendiaClient({ origin: base, headers });
        expect((await client.settings.get()).oidcConfigured).toBe(true);
      } finally {
        await server.stop();
      }
    }));

  test("settings mutations write proxies and provider keys", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const headers = {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        };
        const client = createPendiaClient({ origin: base, headers });
        const updated = await client.settings.update({
          trustedProxyAddresses: ["10.0.0.2", "::ffff:10.0.0.3"],
          artworkRequiresAuth: true,
        });
        expect(updated).toEqual({
          trustedProxyAddresses: ["10.0.0.2", "10.0.0.3"],
          artworkRequiresAuth: true,
          oidcConfigured: false,
          providerKeys: [],
        });
        const bad = await fetch(`${base}/api/settings`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ trustedProxyAddresses: ["not-an-ip"] }),
        });
        expect(bad.status).toBe(400);
        const keyed = await client.settings.setProviderKey({
          name: "tmdb",
          value: "secret",
        });
        expect(keyed.providerKeys).toEqual(["tmdb"]);
        const removed = await client.settings.deleteProviderKey({
          name: "tmdb",
        });
        expect(removed.providerKeys).toEqual([]);
        const missing = await capture(
          client.settings.deleteProviderKey({ name: "tmdb" }),
        );
        expect(missing.code).toBe("NOT_FOUND");
      } finally {
        await server.stop();
      }
    }));

  test("libraries.scanStatus counts queued jobs over RPC and REST", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const headers = { authorization: `Bearer ${token}` };
        const client = createPendiaClient({ origin: base, headers });
        const library = await client.libraries.create({
          name: "Movies",
          medium: "movies",
          rootPath: "/srv/movies",
        });
        expect(await client.libraries.scanStatus({ id: library.id })).toEqual({
          libraryId: library.id,
          counts: { queued: 0, running: 0, completed: 0, failed: 0 },
          latest: null,
        });
        const { jobId } = await client.libraries.scan({ id: library.id });
        const rest = await fetch(
          `${base}/api/libraries/${library.id}/scan-status`,
          { headers },
        );
        expect(rest.status).toBe(200);
        expect(await rest.json()).toEqual({
          libraryId: library.id,
          counts: { queued: 1, running: 0, completed: 0, failed: 0 },
          latest: { id: jobId, state: "queued", error: null },
        });
      } finally {
        await server.stop();
      }
    }));
});
