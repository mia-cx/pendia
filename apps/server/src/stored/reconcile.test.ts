import { describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { files, jobs, libraries, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { readStoreManifest } from "./encode.ts";
import { removeOrphanedStoreFolders } from "./reconcile.ts";
import { requestStoredVersion, setStoredVersionPolicy } from "./service.ts";
import {
  drain,
  fixtureFolder,
  fixturePath,
  scanFolder,
  twoRungPolicy,
  withStoredLibrary,
} from "./testing.ts";

const stored = (db: Database) =>
  db
    .select()
    .from(versions)
    .where(eq(versions.origin, "stored"))
    .orderBy(versions.rung);

const queuedStores = (db: Database) =>
  db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, "store"), eq(jobs.state, "queued")));

describe.skipIf(!databaseUrl)("stored-version reconciliation", () => {
  test(
    "a policy stores complete rungs, a dropped rung and a deleted source take their folders",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await withStoredLibrary(
          db,
          twoRungPolicy,
          async ({ root, library }) => {
            await scanFolder(db, library.id);
            await drain(db);
            const rungs = await stored(db);
            expect(rungs.map((row) => [row.rung, row.complete])).toEqual([
              ["360p", true],
              ["source", true],
            ]);
            const pendia = join(root, `${fixturePath}.pendia`);
            expect((await readdir(pendia)).sort()).toEqual(["360p", "source"]);
            for (const row of rungs)
              expect(
                await readStoreManifest(join(root, row.storedFolder ?? "")),
              ).toMatchObject({ rung: row.rung, complete: true });

            // A rescan finds nothing left to queue.
            await scanFolder(db, library.id);
            await drain(db);
            expect(await queuedStores(db)).toEqual([]);

            await setStoredVersionPolicy(db, admin.id, library.id, {
              rungs: [{ name: "source" }],
            });
            expect((await stored(db)).map((row) => row.rung)).toEqual([
              "source",
            ]);
            expect(await readdir(pendia)).toEqual(["source"]);

            await rm(join(root, fixturePath));
            // While its File row stands, the rungs of a complete Version stay.
            await removeOrphanedStoreFolders(db, library, fixtureFolder);
            expect(await readdir(pendia)).toEqual(["source"]);
            await scanFolder(db, library.id);
            await drain(db);
            expect(await stored(db)).toEqual([]);
            expect(
              await Bun.file(join(pendia, "source", "init.mp4")).exists(),
            ).toBe(false);
            expect(await readdir(join(root, fixtureFolder))).toEqual([]);
          },
        );
      }),
    120_000,
  );

  test(
    "a policy condition the source misses queues nothing, a manual request queues one rung",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const policy: JsonObject = {
          rungs: [
            { name: "source" },
            { name: "360p", height: 360, bitrate: 1_000_000 },
            { name: "1080p", height: 1080, bitrate: 8_000_000 },
          ],
          when: { minHeight: 2160 },
        };
        await withStoredLibrary(db, policy, async ({ library, itemId }) => {
          await scanFolder(db, library.id);
          await drain(db);
          expect(await queuedStores(db)).toEqual([]);
          expect(await stored(db)).toEqual([]);

          expect(
            await requestStoredVersion(db, admin.id, itemId, "360p"),
          ).toEqual({ queued: true });
          expect(
            await requestStoredVersion(db, admin.id, itemId, "360p"),
          ).toEqual({ queued: false });
          const [file] = await db
            .select({ id: files.id })
            .from(files)
            .where(eq(files.itemId, itemId));
          expect(await queuedStores(db)).toEqual([
            {
              payload: {
                type: "store",
                sourceFileId: file?.id ?? "",
                rung: "360p",
              },
            },
          ]);
          // 1080p is taller than the 720p source; 4k is not a policy rung.
          await expect(
            requestStoredVersion(db, admin.id, itemId, "1080p"),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          await expect(
            requestStoredVersion(db, admin.id, itemId, "4k"),
          ).rejects.toMatchObject({ code: "INVALID_INPUT" });

          // The condition only gates the policy's own queueing.
          await drain(db);
          expect((await stored(db)).map((row) => row.rung)).toEqual(["360p"]);
          await scanFolder(db, library.id);
          await drain(db);
          expect((await stored(db)).map((row) => row.rung)).toEqual(["360p"]);
        });
      }),
    120_000,
  );

  test(
    "the stored-version routes read, replace and validate a policy",
    () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const viewer = await createLocalUser(db, admin.id, {
          username: "viewer",
          password: "viewer-pass",
        });
        const { token } = await createApiKey(db, admin.id, "admin");
        const { token: viewerToken } = await createApiKey(
          db,
          viewer.id,
          "viewer",
        );
        const [library] = await db
          .insert(libraries)
          .values({
            name: "Movies",
            medium: "movies",
            rootPath: "/srv/movies",
            configuration: { keep: true },
          })
          .returning();
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const route = `http://127.0.0.1:${server.apiServer?.port}/api/libraries/${library?.id}/stored-versions`;
          const call = (
            method: string,
            bearer: string,
            body?: unknown,
          ): Promise<Response> =>
            fetch(route, {
              method,
              headers: {
                authorization: `Bearer ${bearer}`,
                "content-type": "application/json",
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
          expect(await (await call("GET", token)).json()).toEqual({
            policy: null,
          });
          expect((await call("GET", viewerToken)).status).toBe(403);
          const put = await call("PUT", token, { policy: twoRungPolicy });
          expect(put.status).toBe(200);
          expect(await put.json()).toEqual({ policy: twoRungPolicy });
          const [saved] = await db
            .select({ configuration: libraries.configuration })
            .from(libraries)
            .where(eq(libraries.id, library?.id ?? ""));
          expect(saved?.configuration).toEqual({
            keep: true,
            storedVersions: twoRungPolicy,
          });
          // An encoded rung may not borrow the remux's name.
          expect(
            (
              await call("PUT", token, {
                policy: {
                  rungs: [{ name: "source", height: 720, bitrate: 3_000_000 }],
                },
              })
            ).status,
          ).toBe(400);
          expect(
            (await call("PUT", viewerToken, { policy: null })).status,
          ).toBe(403);
          expect(
            await (await call("PUT", token, { policy: null })).json(),
          ).toEqual({ policy: null });
        } finally {
          await server.stop();
        }
      }),
    30_000,
  );
});
