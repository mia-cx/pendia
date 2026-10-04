import { describe, expect, test } from "bun:test";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  items,
  libraries,
  probeCache,
  progress,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, listJobs, watcherHeartbeatMs } from "../jobs/queue.ts";
import { scanShowDirectory } from "../libraries/scan.ts";
import { readLibraryFile } from "../libraries/walker.ts";
import { createChangeDebouncer } from "../libraries/webhooks.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { readFfprobe } from "../mediums/video-common/probe.ts";
import {
  createWatcherHandler,
  type WatcherClaim,
  type WatcherReport,
} from "./http.ts";

const unusedDebouncer = {
  submitWatched: () => Promise.reject(new Error("No events expected.")),
};

async function setup(db: Database) {
  await migrateDatabase(db);
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const { token } = await createApiKey(db, admin.id, "Watcher");
  const [library] = await db
    .insert(libraries)
    // The api never reads this root: a watched Library's disk is the watcher's.
    .values({ name: "Movies", medium: "movies", rootPath: "/media/movies" })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  return { admin, token, library };
}

function post(path: string, body: unknown, token?: string) {
  return new Request(`http://pendia.test/api/watcher/${path}`, {
    method: "POST",
    headers:
      token === undefined
        ? { "Content-Type": "application/json" }
        : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!databaseUrl)("watcher events", () => {
  test("rejects a missing, wrong or session token", () =>
    withDatabase(async (db) => {
      const { library } = await setup(db);
      const { token: sessionToken } = await login(
        db,
        {
          username: "admin",
          password: "admin-pass",
          clientName: "Test Client",
          deviceId: "device-1",
          deviceName: "Laptop",
        },
        "127.0.0.1",
      );
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      const handler = createWatcherHandler(db, debouncer);
      const batch = { libraryId: library.id, changes: [] };
      try {
        for (const token of [undefined, "x".repeat(43), sessionToken]) {
          const response = await handler(post("events", batch, token));
          expect(response?.status).toBe(401);
        }
      } finally {
        await debouncer.close();
      }
    }));

  test("rejects a path that escapes the library root", () =>
    withDatabase(async (db) => {
      const { token, library } = await setup(db);
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      const handler = createWatcherHandler(db, debouncer);
      try {
        for (const path of ["../Alien (1979)/Alien.mkv", "/etc/passwd"]) {
          const response = await handler(
            post(
              "events",
              { libraryId: library.id, changes: [{ kind: "add", path }] },
              token,
            ),
          );
          expect(response?.status).toBe(400);
        }
      } finally {
        await debouncer.close();
      }
      expect(await listJobs(db, { type: "scan" })).toHaveLength(0);
    }));

  test("a batch of file events becomes one scan job with relative paths", () =>
    withDatabase(async (db) => {
      const { token, library } = await setup(db);
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      const handler = createWatcherHandler(db, debouncer);
      try {
        const response = await handler(
          post(
            "events",
            {
              libraryId: library.id,
              changes: [
                { kind: "add", path: "Alien (1979)/Alien.mkv.part" },
                {
                  kind: "move",
                  path: "Alien (1979)/Alien.mkv",
                  previousPath: "Alien (1979)/Alien.mkv.part",
                },
                {
                  kind: "move",
                  path: "Alien (1979)/Alien (1979).mkv",
                  previousPath: "Alien (1979)/Alien.mkv",
                },
                { kind: "delete", path: "Alien (1979)/Alien (1979).en.srt" },
                { kind: "delete", path: "Alien (1979)/Alien (1979).mkv" },
              ],
            },
            token,
          ),
        );
        expect(response?.status).toBe(202);
        expect(await response?.json()).toEqual({ accepted: 3 });
      } finally {
        await debouncer.close();
      }
      const queued = await listJobs(db, { type: "scan" });
      expect(queued.map((job) => job.payload)).toEqual([
        {
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
          changes: [
            { kind: "add", path: "Alien (1979)/Alien.mkv", providerIds: {} },
            {
              kind: "move",
              path: "Alien (1979)/Alien (1979).mkv",
              previousPath: "Alien (1979)/Alien.mkv",
              providerIds: {},
            },
            {
              kind: "delete",
              path: "Alien (1979)/Alien (1979).mkv",
              target: "file",
              providerIds: {},
            },
          ],
        },
      ]);
    }));
});

describe.skipIf(!databaseUrl)("watcher scans", () => {
  test("a worker leaves a watched Library's scans to the watcher", () =>
    withDatabase(async (db) => {
      const { token, library } = await setup(db);
      const handler = createWatcherHandler(db, unusedDebouncer);
      const queue = createJobQueue(db);
      const first = await queue.enqueue({
        type: "scan",
        libraryId: library.id,
        path: "Alien (1979)",
      });
      const second = await queue.enqueue({
        type: "scan",
        libraryId: library.id,
        path: "Heat (1995)",
      });
      const response = await handler(
        post("claim", { libraryIds: [library.id] }, token),
      );
      const claimed: WatcherClaim = await response?.json();
      expect(claimed.job).toEqual({
        id: first.id,
        attempts: 1,
        libraryId: library.id,
        path: "Alien (1979)",
        medium: "movies",
        cached: [],
        check: [],
      });
      expect(await queue.claim()).toBeUndefined();
      await db
        .update(libraries)
        .set({
          watcherSeenAt: sql`statement_timestamp() - ${watcherHeartbeatMs + 1_000} * interval '1 millisecond'`,
        })
        .where(eq(libraries.id, library.id));
      expect((await queue.claim())?.id).toBe(second.id);
    }));

  test("a claimed scan with a reported probe writes the movie and the probe cache", () =>
    withVideoFixture((dir) =>
      withDatabase(async (db) => {
        const { token, library } = await setup(db);
        const handler = createWatcherHandler(db, unusedDebouncer);
        const path = "Alien (1979)/Alien (1979).mkv";
        await mkdir(join(dir, "Alien (1979)"));
        await createVideoFixture(join(dir, path));
        await createJobQueue(db).enqueue({
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
        });
        const claimed: WatcherClaim = await (
          await handler(post("claim", { libraryIds: [library.id] }, token))
        )?.json();
        if (claimed.job === null) throw new Error("No scan was claimed.");
        const file = await readLibraryFile(dir, path);
        const report = {
          attempts: claimed.job.attempts,
          files: [
            {
              path,
              bytes: String(file.bytes),
              modifiedNs: String(file.modifiedNs),
            },
          ],
          probes: [
            {
              path,
              ffprobe: await readFfprobe(join(dir, path)),
              keyframesSeconds: (await readKeyframeIndex(join(dir, path)))
                .keyframesSeconds,
            },
          ],
        } satisfies WatcherReport;
        const response = await handler(
          post(`jobs/${claimed.job.id}`, report, token),
        );
        expect(await response?.json()).toEqual({ state: "completed" });

        const [item] = await db.select().from(items);
        expect(item).toMatchObject({
          kind: "movie",
          canonicalFolder: "Alien (1979)",
        });
        const [stored] = await db.select().from(files);
        expect(stored).toMatchObject({ path, bytes: file.bytes });
        expect(await db.select().from(versions)).toHaveLength(1);
        const kinds = (await db.select().from(streams)).map(
          (stream) => stream.kind,
        );
        expect(kinds).toContain("video");
        const [cached] = await db.select().from(probeCache);
        expect(cached).toMatchObject({
          path,
          bytes: file.bytes,
          modifiedNs: file.modifiedNs,
        });
        expect(cached?.result.streams.length).toBe(kinds.length);
      }),
    ));

  test("a watcher Show folder move preserves hierarchy and Progress without provider ids", () =>
    withVideoFixture((root) =>
      withDatabase(async (db) => {
        const { admin, token, library } = await setup(db);
        await db
          .update(libraries)
          .set({ name: "Shows", medium: "shows", rootPath: "/media/shows" })
          .where(eq(libraries.id, library.id));
        expect(root).not.toBe("/media/shows");
        const oldShow = "Old Show";
        const newShow = "New Show";
        const oldPath = `${oldShow}/Season 01/Show S01E01.mkv`;
        const newPath = `${newShow}/Season 01/Show S01E01.mkv`;
        await mkdir(join(root, oldShow, "Season 01"), { recursive: true });
        await createVideoFixture(join(root, oldPath));
        const debouncer = createChangeDebouncer(db, { delayMs: 60_000 });
        const handler = createWatcherHandler(db, debouncer);
        const finishScan = async (path: string, scope: string) => {
          const claimed: WatcherClaim = await (
            await handler(post("claim", { libraryIds: [library.id] }, token))
          )?.json();
          if (claimed.job === null) throw new Error("No scan was claimed.");
          expect(claimed.job).toMatchObject({ path: scope, medium: "shows" });
          const file = await readLibraryFile(root, path);
          const response = await handler(
            post(
              `jobs/${claimed.job.id}`,
              {
                attempts: claimed.job.attempts,
                files: [
                  {
                    path,
                    bytes: String(file.bytes),
                    modifiedNs: String(file.modifiedNs),
                  },
                ],
                probes: [
                  {
                    path,
                    ffprobe: await readFfprobe(join(root, path)),
                    keyframesSeconds: (
                      await readKeyframeIndex(join(root, path))
                    ).keyframesSeconds,
                  },
                ],
              } satisfies WatcherReport,
              token,
            ),
          );
          expect(response?.status).toBe(200);
          expect(await response?.json()).toEqual({ state: "completed" });
        };
        try {
          await createJobQueue(db).enqueue({
            type: "scan",
            libraryId: library.id,
            path: oldShow,
          });
          await finishScan(oldPath, oldShow);
          const before = await db.select().from(items).orderBy(asc(items.id));
          expect(before.map((item) => item.kind).sort()).toEqual([
            "episode",
            "season",
            "show",
          ]);
          const [file] = await db.select().from(files);
          if (!file) throw new Error("Initial scan produced no File.");
          await db.insert(progress).values({
            userId: admin.id,
            itemId: file.itemId,
            versionId: file.versionId,
            format: "video",
            positionSeconds: 33,
            playCount: 2,
          });
          const progressBefore = await db.select().from(progress);

          await rename(join(root, oldShow), join(root, newShow));
          const response = await handler(
            post(
              "events",
              {
                libraryId: library.id,
                changes: [
                  { kind: "move", previousPath: oldPath, path: newPath },
                ],
              },
              token,
            ),
          );
          expect(response?.status).toBe(202);
          await debouncer.close();
          const [queued] = await listJobs(db, {
            type: "scan",
            state: "queued",
          });
          expect(queued?.payload).toEqual({
            type: "scan",
            libraryId: library.id,
            path: newShow,
            changes: [
              {
                kind: "move",
                previousPath: oldPath,
                path: newPath,
                providerIds: {},
              },
            ],
          });
          await finishScan(newPath, newShow);

          const after = await db.select().from(items).orderBy(asc(items.id));
          expect(
            after.map(({ id, kind, parentId, canonicalFolder }) => ({
              id,
              kind,
              parentId,
              canonicalFolder,
            })),
          ).toEqual(
            before.map(({ id, kind, parentId, canonicalFolder }) => ({
              id,
              kind,
              parentId,
              canonicalFolder: canonicalFolder?.replace(oldShow, newShow),
            })),
          );
          expect(await db.select().from(files)).toMatchObject([
            {
              id: file.id,
              itemId: file.itemId,
              versionId: file.versionId,
              path: newPath,
            },
          ]);
          expect(
            (await db.select().from(versions)).map((version) => version.id),
          ).toEqual([file.versionId]);
          expect(await db.select().from(progress)).toEqual(progressBefore);
        } finally {
          await debouncer.close();
        }
      }),
    ));

  test("a claimed Show move lists the Show's other Files to check on disk", () =>
    withVideoFixture((root) =>
      withDatabase(async (db) => {
        const { token, library } = await setup(db);
        await db
          .update(libraries)
          .set({ medium: "shows", rootPath: root })
          .where(eq(libraries.id, library.id));
        const moved = "Old Show/Season 01/Show S01E01.mkv";
        const sibling = "Old Show/Season 01/Show S01E02.mkv";
        await mkdir(join(root, "Old Show", "Season 01"), { recursive: true });
        await createVideoFixture(join(root, moved));
        await createVideoFixture(join(root, sibling));
        await scanShowDirectory(db, library.id, "Old Show");
        const handler = createWatcherHandler(db, unusedDebouncer);
        await createJobQueue(db).enqueue({
          type: "scan",
          libraryId: library.id,
          path: "New Show",
          changes: [
            {
              kind: "move",
              path: "New Show/Season 01/Show S01E01.mkv",
              previousPath: moved,
              providerIds: {},
            },
          ],
        });
        const claimed: WatcherClaim = await (
          await handler(post("claim", { libraryIds: [library.id] }, token))
        )?.json();
        expect(claimed.job?.check).toEqual([sibling]);
      }),
    ));

  test("a report from a stale attempt is refused", () =>
    withDatabase(async (db) => {
      const { token, library } = await setup(db);
      const handler = createWatcherHandler(db, unusedDebouncer);
      await createJobQueue(db).enqueue({
        type: "scan",
        libraryId: library.id,
        path: "Alien (1979)",
      });
      const claimed: WatcherClaim = await (
        await handler(post("claim", { libraryIds: [library.id] }, token))
      )?.json();
      if (claimed.job === null) throw new Error("No scan was claimed.");
      const response = await handler(
        post(
          `jobs/${claimed.job.id}`,
          { attempts: claimed.job.attempts + 1, error: "late" },
          token,
        ),
      );
      expect(response?.status).toBe(409);
    }));
});
