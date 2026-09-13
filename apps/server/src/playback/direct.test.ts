import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { setPermissionOverride } from "../auth/permissions.ts";
import { issuePlaybackToken } from "../auth/playback-tokens.ts";
import {
  authenticate,
  createApiKey,
  login,
  revokeSession,
} from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  items,
  libraries,
  libraryAccess,
  sessionRegistry,
  streams,
  users,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { type PlanInput, planPlayback } from "./planning.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const fixtureBytes = "0123456789abcdefghijklmnopqrstuvwxyz";

const profile: PlanInput["profile"] = {
  containers: ["mp4"],
  videoCodecs: [
    {
      codec: "h264",
      profiles: ["high"],
      maxLevel: 41,
      maxWidth: 1920,
      maxHeight: 1080,
    },
  ],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr"],
};

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pendia-direct-"));
  await writeFile(join(root, "movie.mp4"), fixtureBytes);
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function seedDirect(db: Database, root: string) {
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
  const caller = await authenticate(db, accountToken);
  const { token: adminToken } = await login(
    db,
    { username: "admin", password: "secret", ...device },
    "127.0.0.1",
  );
  const { token: keyToken } = await createApiKey(db, owner.id, "player");
  const keyCaller = await authenticate(db, keyToken);
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: root })
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
  const [version] = await db
    .insert(versions)
    .values({
      itemId: item.id,
      itemKind: "movie",
      libraryId: library.id,
      label: "Original",
      format: "video",
      bytes: 36n,
      durationSeconds: 120,
    })
    .returning();
  if (!version) throw new Error("Version insert returned no row.");
  const [file] = await db
    .insert(files)
    .values({
      versionId: version.id,
      itemId: item.id,
      libraryId: library.id,
      path: "movie.mp4",
      order: 0,
      bytes: 36n,
      modifiedAt: new Date(),
      container: "mp4",
      durationSeconds: 120,
    })
    .returning();
  if (!file) throw new Error("File insert returned no row.");
  await db.insert(streams).values([
    {
      versionId: version.id,
      fileId: file.id,
      index: 0,
      kind: "video",
      codec: "h264",
      profile: "high",
      level: 41,
      width: 1920,
      height: 1080,
      bitrate: 5_000_000n,
      hdr: "sdr",
    },
    {
      versionId: version.id,
      fileId: file.id,
      index: 1,
      kind: "audio",
      codec: "aac",
      channels: 2,
    },
    {
      versionId: version.id,
      fileId: file.id,
      index: 2,
      kind: "subtitle",
      codec: "subrip",
    },
  ]);
  return {
    admin,
    owner,
    caller,
    keyCaller,
    accountToken,
    adminToken,
    keyToken,
    library,
    item,
    version,
    file,
  };
}

function planRequest(bearer: boolean) {
  return new Request("http://pendia.test/api/playback/plan", {
    method: "POST",
    headers: bearer ? { authorization: "Bearer service" } : {},
  });
}

async function planDirect(
  db: Database,
  caller: Awaited<ReturnType<typeof authenticate>>,
  itemId: string,
  versionId: string,
  bearer: boolean,
) {
  const planned = await planPlayback(
    db,
    caller,
    { itemId, versionId, profile },
    { request: planRequest(bearer), peerAddress: "127.0.0.1" },
  );
  if (planned.sessionId === null || planned.url === null)
    throw new Error("Expected a direct-play session and URL.");
  return { sessionId: planned.sessionId, url: planned.url };
}

describe.skipIf(!databaseUrl)("direct playback", () => {
  test("serves the planned file with byte ranges over HTTP", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fixture = await makeFixture();
      try {
        const fx = await seedDirect(db, fixture.root);
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const planned = await planDirect(
            db,
            fx.keyCaller,
            fx.item.id,
            fx.version.id,
            true,
          );
          expect(planned.url).toContain(
            `/api/playback/${planned.sessionId}/${fx.item.id}/direct?token=`,
          );

          const full = await fetch(`${base}${planned.url}`);
          expect(full.status).toBe(200);
          expect(full.headers.get("content-type")).toContain("video/mp4");
          expect(full.headers.get("content-length")).toBe("36");
          expect(full.headers.get("cache-control")).toBe("no-store");
          expect(full.headers.get("vary")).toContain("cookie");
          expect(full.headers.get("vary")).toContain("authorization");
          expect(full.headers.get("x-content-type-options")).toBe("nosniff");
          expect(full.headers.get("referrer-policy")).toBe("no-referrer");
          expect(full.headers.get("accept-ranges")).toBe("bytes");
          expect(await full.text()).toBe(fixtureBytes);

          const ranged = (range: string) =>
            fetch(`${base}${planned.url}`, { headers: { range } });
          const middle = await ranged("bytes=10-19");
          expect(middle.status).toBe(206);
          expect(middle.headers.get("content-range")).toBe("bytes 10-19/36");
          expect(middle.headers.get("content-length")).toBe("10");
          expect(await middle.text()).toBe("abcdefghij");
          const tail = await ranged("bytes=30-");
          expect(tail.status).toBe(206);
          expect(tail.headers.get("content-range")).toBe("bytes 30-35/36");
          expect(await tail.text()).toBe("uvwxyz");
          const suffix = await ranged("bytes=-4");
          expect(suffix.status).toBe(206);
          expect(suffix.headers.get("content-range")).toBe("bytes 32-35/36");
          expect(await suffix.text()).toBe("wxyz");
          const clipped = await ranged("bytes=34-99");
          expect(clipped.status).toBe(206);
          expect(clipped.headers.get("content-range")).toBe("bytes 34-35/36");
          expect(await clipped.text()).toBe("yz");
          const pastEnd = await ranged("bytes=36-");
          expect(pastEnd.status).toBe(416);
          expect(pastEnd.headers.get("content-range")).toBe("bytes */36");
          await pastEnd.body?.cancel();

          const head = await fetch(`${base}${planned.url}`, {
            method: "HEAD",
          });
          expect(head.status).toBe(200);
          expect(head.headers.get("content-length")).toBe("36");
          expect(head.headers.get("accept-ranges")).toBe("bytes");
          expect(await head.text()).toBe("");
        } finally {
          await server.stop();
        }
      } finally {
        await fixture.cleanup();
      }
    }));

  test("rejects invalid, foreign and non-token credentials without serving", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fixture = await makeFixture();
      try {
        const fx = await seedDirect(db, fixture.root);
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const planned = await planDirect(
            db,
            fx.keyCaller,
            fx.item.id,
            fx.version.id,
            true,
          );
          const scope = {
            sessionId: planned.sessionId,
            itemId: fx.item.id,
          };
          const path = `/api/playback/${scope.sessionId}/${scope.itemId}/direct`;
          const token = new URL(`${base}${planned.url}`).searchParams.get(
            "token",
          );
          if (token === null) throw new Error("Missing playback token.");
          const ranged = (target: string, headers: HeadersInit = {}) =>
            fetch(`${base}${target}`, {
              headers: { range: "bytes=0-9", ...headers },
            });
          const expectUnauthorized = async (
            target: string,
            headers: HeadersInit = {},
          ) => {
            const response = await ranged(target, headers);
            expect(response.status).toBe(401);
            const body = (await response.json()) as {
              error: { code: string };
            };
            expect(body.error.code).toBe("UNAUTHENTICATED");
          };

          const expired = await issuePlaybackToken(
            db,
            fx.keyCaller,
            scope,
            Date.now() - 301_000,
          );
          await expectUnauthorized(`${path}?token=${expired.token}`);

          const second = await planDirect(
            db,
            fx.keyCaller,
            fx.item.id,
            fx.version.id,
            true,
          );
          const foreignSession = new URL(
            `${base}${second.url}`,
          ).searchParams.get("token");
          await expectUnauthorized(`${path}?token=${foreignSession}`);
          await expectUnauthorized(
            `/api/playback/${scope.sessionId}/${Bun.randomUUIDv7()}/direct?token=${token}`,
          );

          const last = token.at(-1);
          const flipped = `${token.slice(0, -1)}${last === "a" ? "b" : "a"}`;
          await expectUnauthorized(`${path}?token=${flipped}`);
          await expectUnauthorized(`${path}?token=${token}&token=${token}`);
          await expectUnauthorized(path);
          await expectUnauthorized(`${path}?api_key=${fx.keyToken}`);
          await expectUnauthorized(`${path}?token=${fx.accountToken}`);
          await expectUnauthorized(`${path}?token=not-a-token`, {
            cookie: `pendia_session=${fx.accountToken}`,
          });
          await expectUnauthorized(
            `/api/playback/nope/${scope.itemId}/direct?token=${token}`,
          );
          await expectUnauthorized(
            `/api/playback/${scope.sessionId}/nope/direct?token=${token}`,
          );
        } finally {
          await server.stop();
        }
      } finally {
        await fixture.cleanup();
      }
    }));

  test("cookie session auth serves the file and enforces origin rules", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fixture = await makeFixture();
      try {
        const fx = await seedDirect(db, fixture.root);
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const planned = await planDirect(
            db,
            fx.caller,
            fx.item.id,
            fx.version.id,
            false,
          );
          expect(planned.url).toBe(
            `/api/playback/${planned.sessionId}/${fx.item.id}/direct`,
          );
          const cookie = `pendia_session=${fx.accountToken}`;

          const full = await fetch(`${base}${planned.url}`, {
            headers: { cookie },
          });
          expect(full.status).toBe(200);
          expect(await full.text()).toBe(fixtureBytes);

          const foreign = await fetch(`${base}${planned.url}`, {
            headers: { cookie, origin: "http://evil.test" },
          });
          expect(foreign.status).toBe(403);
          const crossSite = await fetch(`${base}${planned.url}`, {
            headers: { cookie, "sec-fetch-site": "cross-site" },
          });
          expect(crossSite.status).toBe(403);

          const other = await fetch(`${base}${planned.url}`, {
            headers: { cookie: `pendia_session=${fx.adminToken}` },
          });
          expect(other.status).toBe(401);

          const posted = await fetch(`${base}${planned.url}`, {
            method: "POST",
            headers: { cookie },
          });
          expect(posted.status).toBe(405);
          expect(posted.headers.get("allow")).toBe("GET, HEAD");
          await posted.body?.cancel();

          await revokeSession(db, fx.admin.id, fx.caller.credential.id);
          const revoked = await fetch(`${base}${planned.url}`, {
            headers: { cookie },
          });
          expect(revoked.status).toBe(401);
        } finally {
          await server.stop();
        }
      } finally {
        await fixture.cleanup();
      }
    }));

  test("revoked permissions, stopped sessions and disabled owners reject", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fixture = await makeFixture();
      try {
        const fx = await seedDirect(db, fixture.root);
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const planned = await planDirect(
            db,
            fx.keyCaller,
            fx.item.id,
            fx.version.id,
            true,
          );
          const cookie = `pendia_session=${fx.accountToken}`;

          await db.insert(libraryAccess).values({
            libraryId: fx.library.id,
            userId: fx.owner.id,
            allowed: false,
          });
          expect((await fetch(`${base}${planned.url}`)).status).toBe(403);
          expect(
            (
              await fetch(`${base}${planned.url.split("?")[0]}`, {
                headers: { cookie },
              })
            ).status,
          ).toBe(403);
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
          expect((await fetch(`${base}${planned.url}`)).status).toBe(403);
          await setPermissionOverride(
            db,
            fx.admin.id,
            fx.owner.id,
            "play",
            null,
          );

          await db
            .update(sessionRegistry)
            .set({ state: "stopped" })
            .where(eq(sessionRegistry.id, planned.sessionId));
          expect((await fetch(`${base}${planned.url}`)).status).toBe(401);
          await db
            .update(sessionRegistry)
            .set({ state: "playing" })
            .where(eq(sessionRegistry.id, planned.sessionId));

          await db
            .update(users)
            .set({ disabledAt: new Date() })
            .where(eq(users.id, fx.owner.id));
          expect((await fetch(`${base}${planned.url}`)).status).toBe(401);
        } finally {
          await server.stop();
        }
      } finally {
        await fixture.cleanup();
      }
    }));

  test("unsafe or missing library files answer 404 without leaking bytes", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fixture = await makeFixture();
      const outside = await makeFixture();
      try {
        const fx = await seedDirect(db, fixture.root);
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const planned = await planDirect(
            db,
            fx.keyCaller,
            fx.item.id,
            fx.version.id,
            true,
          );
          const expectNotFound = async (path: string) => {
            await db
              .update(files)
              .set({ path })
              .where(eq(files.id, fx.file.id));
            const response = await fetch(`${base}${planned.url}`);
            expect(response.status).toBe(404);
            const body = await response.text();
            expect(body).not.toContain(fixtureBytes);
            expect(body).not.toContain(fixture.root);
            expect(body).not.toContain(outside.root);
          };

          await expectNotFound("../movie.mp4");
          await expectNotFound(join(fixture.root, "movie.mp4"));

          await symlink(
            join(outside.root, "movie.mp4"),
            join(fixture.root, "leaf.mp4"),
          );
          await expectNotFound("leaf.mp4");

          await symlink(outside.root, join(fixture.root, "linked"));
          await expectNotFound("linked/movie.mp4");

          await expectNotFound("missing.mp4");
        } finally {
          await server.stop();
        }
      } finally {
        await fixture.cleanup();
        await outside.cleanup();
      }
    }));
});
