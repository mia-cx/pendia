import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { jobs } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import type { Rung } from "./policy.ts";
import { requestStoredVersion, setStoredVersionPolicy } from "./service.ts";
import { readStoreStatus } from "./status.ts";
import { fixturePath, withStoredLibrary } from "./testing.ts";

const rungs: readonly Rung[] = [
  { name: "source" },
  { name: "360p", height: 360, bitrate: 1_000_000 },
];

describe.skipIf(!databaseUrl)("store status", () => {
  test(
    "a policy edit and a manual request queue jobs; a running job counts its segments",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await withStoredLibrary(db, null, async ({ root, library, itemId }) => {
          expect(await readStoreStatus(db, admin.id)).toEqual({
            running: [],
            queued: { total: 0, next: [] },
          });

          // The 720p fixture misses the condition, so only the request queues.
          await setStoredVersionPolicy(db, admin.id, library.id, {
            rungs,
            when: { minHeight: 2160 },
          });
          expect((await readStoreStatus(db, admin.id)).queued.total).toBe(0);
          expect(
            await requestStoredVersion(db, admin.id, itemId, "360p"),
          ).toEqual({ queued: true });
          const requested = await readStoreStatus(db, admin.id);
          expect(requested.queued.total).toBe(1);
          expect(requested.queued.next).toMatchObject([
            { rung: "360p", item: { id: itemId, title: "Movie" } },
          ]);

          await setStoredVersionPolicy(db, admin.id, library.id, { rungs });
          const edited = await readStoreStatus(db, admin.id);
          expect(edited.queued.total).toBe(2);
          expect(edited.queued.next.map((job) => job.rung).sort()).toEqual([
            "360p",
            "source",
          ]);

          await db
            .update(jobs)
            .set({ state: "running" })
            .where(
              and(
                eq(jobs.type, "store"),
                sql`${jobs.payload}->>'rung' = '360p'`,
              ),
            );
          const folder = join(root, `${fixturePath}.pendia`, "360p");
          await mkdir(join(folder, ".partial"), { recursive: true });
          await Bun.write(join(folder, "0.m4s"), "0");
          await Bun.write(join(folder, "1.m4s"), "1");
          await Bun.write(join(folder, ".partial", "2.m4s"), "2");
          await Bun.write(join(folder, "init.mp4"), "init");
          const status = await readStoreStatus(db, admin.id);
          // The 12 s fixture cuts every 3 s.
          expect(status.running).toMatchObject([
            {
              rung: "360p",
              item: { id: itemId },
              segmentsDone: 2,
              segmentsTotal: 4,
            },
          ]);
          expect(status.queued).toMatchObject({
            total: 1,
            next: [{ rung: "source" }],
          });
        });
      }),
    60_000,
  );

  test("needs manage-transcoding", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      await expect(readStoreStatus(db, viewer.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }));
});
