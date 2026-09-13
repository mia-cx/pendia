import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { sessionCookieName } from "../auth/http.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import type { pendiaRouter } from "./router.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const profile = {
  containers: ["mkv"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr" as const],
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
  return { admin, owner, accountToken, keyToken };
}

async function withScannedLibrary(
  db: Database,
  adminId: string,
  run: (scanned: {
    itemId: string;
    versionId: string;
    bytes: Buffer;
  }) => Promise<void>,
) {
  await withVideoFixture(async (root) => {
    const folder = join(root, "Movie (2026)");
    await mkdir(folder);
    const file = join(folder, "Movie.mkv");
    await createVideoFixture(file, { width: 320, height: 180 });
    const bytes = await readFile(file);
    const library = await createLibrary(db, adminId, {
      name: "Movies",
      medium: "movies",
      rootPath: root,
    });
    const scanned = await scanDirectory(db, library.id, "Movie (2026)");
    const versionId = scanned.versionIds[0];
    if (scanned.itemId === null || versionId === undefined)
      throw new Error("Expected exactly one scanned item and version.");
    await run({ itemId: scanned.itemId, versionId, bytes });
  });
}

describe.skipIf(!databaseUrl)("direct-play end to end", () => {
  test("plans, serves, tracks and shelves a real scanned file", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      await withScannedLibrary(db, fx.admin.id, async (scanned) => {
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = rpcClient(base, fx.keyToken);
          const { itemId, versionId, bytes } = scanned;

          const detail = await client.items.get({ id: itemId });
          expect(detail).toMatchObject({
            id: itemId,
            kind: "movie",
            title: "Movie",
            year: 2026,
          });

          const planned = await client.playback.plan({
            itemId,
            versionId,
            profile,
          });
          expect(planned.method).toBe("direct-play");
          if (planned.url === null || planned.sessionId === null)
            throw new Error("Direct play must return a URL and session.");
          expect(planned.url.includes(fx.keyToken)).toBe(false);
          expect(planned.url.includes(fx.accountToken)).toBe(false);

          const full = await fetch(`${base}${planned.url}`);
          expect(full.status).toBe(200);
          expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(
            true,
          );
          const ranged = await fetch(`${base}${planned.url}`, {
            headers: { range: "bytes=0-127" },
          });
          expect(ranged.status).toBe(206);
          expect(ranged.headers.get("content-range")).toBe(
            `bytes 0-127/${bytes.length}`,
          );
          expect(
            Buffer.from(await ranged.arrayBuffer()).equals(
              bytes.subarray(0, 128),
            ),
          ).toBe(true);

          const started = await client.playback.start({
            sessionId: planned.sessionId,
            itemId,
          });
          expect(started.state).toBe("playing");
          expect(started.progress?.positionSeconds).toBe(0);
          await client.playback.progress({
            sessionId: planned.sessionId,
            itemId,
            positionSeconds: 0.5,
          });
          const stored = await client.playback.getProgress({ itemId });
          expect(stored).toMatchObject({
            versionId,
            format: "video",
            positionSeconds: 0.5,
          });
          const shelf = await client.shelves.continueWatching({});
          const entry = shelf.items.find((row) => row.item.id === itemId);
          expect(entry?.progress.positionSeconds).toBe(0.5);
          expect(
            await client.marks.setFavourite({ itemId, favourite: true }),
          ).toEqual({ favourite: true, rating: null });
          expect(await client.marks.setRating({ itemId, rating: 8.5 })).toEqual(
            { favourite: true, rating: 8.5 },
          );
          expect(await client.marks.get({ itemId })).toEqual({
            favourite: true,
            rating: 8.5,
          });
          await client.playback.stop({
            sessionId: planned.sessionId,
            itemId,
            positionSeconds: 0.5,
          });
          expect((await fetch(`${base}${planned.url}`)).status).toBe(401);

          const replanned = await client.playback.plan({
            itemId,
            versionId,
            profile,
          });
          if (replanned.url === null || replanned.sessionId === null)
            throw new Error("Direct play must return a URL and session.");
          expect(replanned.sessionId).not.toBe(planned.sessionId);
          expect(await client.playback.resume({ itemId, versionId })).toEqual({
            positionSeconds: 0.5,
          });
          const restarted = await client.playback.start({
            sessionId: replanned.sessionId,
            itemId,
          });
          expect(restarted.state).toBe("playing");
          expect(restarted.progress?.positionSeconds).toBe(0.5);
          await client.playback.stop({
            sessionId: replanned.sessionId,
            itemId,
            positionSeconds: 0.75,
            completed: true,
          });
          expect(await client.playback.resume({ itemId, versionId })).toEqual({
            positionSeconds: 0,
          });
          const emptyShelf = await client.shelves.continueWatching({});
          expect(emptyShelf.items).toHaveLength(0);
        } finally {
          await server.stop();
        }
      });
    }));

  test("rejects anonymous, foreign-origin and malformed requests", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const fx = await seed(db);
      await withScannedLibrary(db, fx.admin.id, async (scanned) => {
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = rpcClient(base, fx.keyToken);
          const { itemId, versionId } = scanned;

          expect(
            (
              await capture(
                rpcClient(base).playback.plan({ itemId, versionId, profile }),
              )
            ).status,
          ).toBe(401);

          const planned = await client.playback.plan({
            itemId,
            versionId,
            profile,
          });
          if (planned.url === null || planned.sessionId === null)
            throw new Error("Direct play must return a URL and session.");

          const cookie = {
            cookie: `${sessionCookieName}=${fx.accountToken}`,
            origin: "http://evil.test",
            "content-type": "application/json",
          };
          const foreign = async (path: string, body: unknown) => {
            const response = await fetch(`${base}/api${path}`, {
              method: "POST",
              headers: cookie,
              body: JSON.stringify(body),
            });
            await response.arrayBuffer();
            return response.status;
          };
          expect(
            await foreign("/playback/plan", { itemId, versionId, profile }),
          ).toBe(403);
          const scope = `/playback/${planned.sessionId}/${itemId}`;
          expect(await foreign(`${scope}/start`, {})).toBe(403);
          expect(
            await foreign(`${scope}/progress`, { positionSeconds: 0.5 }),
          ).toBe(403);
          expect(await foreign(`${scope}/stop`, { positionSeconds: 0.5 })).toBe(
            403,
          );
          expect(await foreign(`${scope}/refresh`, {})).toBe(403);

          expect(
            (
              await capture(
                client.playback.plan({
                  itemId: "not-a-uuid",
                  versionId,
                  profile,
                }),
              )
            ).status,
          ).toBe(400);
        } finally {
          await server.stop();
        }
      });
    }));
});
