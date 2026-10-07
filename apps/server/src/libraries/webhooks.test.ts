import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asc, sql } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { files, items, providerIds, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { createJobQueue, type Job, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
import { scanDirectory, scanShowDirectory } from "./scan.ts";
import type { ChangeEvent } from "./servarr.ts";
import { addRoot, insertLibraries } from "./testing.ts";
import {
  createChangeDebouncer,
  createServarrWebhookHandler,
} from "./webhooks.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const movieIds = { tmdb: "348", imdb: "tt0078748" };

async function loadFixture(name: string): Promise<unknown> {
  const text = await readFile(
    join(import.meta.dir, "fixtures", "servarr", name),
    "utf8",
  );
  const payload: unknown = JSON.parse(text);
  return payload;
}

async function insertLibrary(
  db: Database,
  name: string,
  rootPath: string,
  medium: "movies" | "shows" = "movies",
) {
  const [library] = await insertLibraries(db, { name, medium, rootPath });
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

async function waitForScanJobs(db: Database, count: number) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const found = await listJobs(db, { state: "queued", type: "scan" });
    if (found.length >= count) return found;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for ${count} queued scan jobs; found ${found.length}.`,
      );
    await Bun.sleep(10);
  }
}

describe.skipIf(!databaseUrl)("servarr webhooks", () => {
  test.each(["queued", "running"] as const)(
    "a later watcher move survives a %s scan of the same folder",
    (state) =>
      withDatabase(async (db) => {
        await withVideoFixture(async (root) => {
          const folder = "Alien (1979)";
          const oldPath = `${folder}/old.mkv`;
          const newPath = `${folder}/new.mkv`;
          await mkdir(join(root, folder));
          await createVideoFixture(join(root, oldPath));
          const library = await insertLibrary(db, "Movies", root);
          const debouncer = createChangeDebouncer(db);
          const queue = createJobQueue(db);
          const registry = createJobRegistry();
          registerLibraryJobs(db, registry);
          const first = await queue.enqueue({
            type: "scan",
            libraryId: library.id,
            path: folder,
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: oldPath,
                providerIds: {},
              },
            ],
          });
          const held =
            state === "running" ? await queue.claim(["scan"]) : undefined;
          if (held) await registry.run(held);
          else await scanDirectory(db, library.id, folder);
          const [original] = await db.select().from(files);
          if (!original) throw new Error("Initial File was not imported.");
          await rename(join(root, oldPath), join(root, newPath));
          await debouncer.submitWatched(library.rootId, [
            { kind: "move", previousPath: oldPath, path: newPath },
          ]);
          await debouncer.close();
          if (held) await queue.complete(held);
          for (;;) {
            const job = await queue.claim(["scan"]);
            if (!job) break;
            await registry.run(job);
            await queue.complete(job);
          }
          expect(await db.select().from(files)).toMatchObject([
            { id: original.id, path: newPath },
          ]);
          expect(
            (await listJobs(db, { type: "scan" })).map((job) => job.id),
          ).toEqual([first.id]);
        });
      }),
  );

  test("three changes for one movie directory become one scan job", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await debouncer.submit("radarr", [
          {
            kind: "add",
            path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
            providerIds: movieIds,
          },
          {
            kind: "move",
            path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-2160p].mkv",
            previousPath:
              "/media/movies/Alien (1979) {tmdb-348}/Alien.1979.2160p.BluRay.mkv",
            providerIds: movieIds,
          },
          {
            kind: "delete",
            path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
            target: "file",
            providerIds: movieIds,
          },
        ]);
        const jobs = await waitForScanJobs(db, 1);
        await Bun.sleep(30);
        expect(await listJobs(db, { type: "scan" })).toHaveLength(1);
        expect(jobs[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979) {tmdb-348}",
          changes: [
            {
              kind: "add",
              rootId: library.rootId,
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
              providerIds: movieIds,
            },
            {
              kind: "move",
              rootId: library.rootId,
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-2160p].mkv",
              previousPath:
                "Alien (1979) {tmdb-348}/Alien.1979.2160p.BluRay.mkv",
              providerIds: movieIds,
            },
            {
              kind: "delete",
              rootId: library.rootId,
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
              target: "file",
              providerIds: movieIds,
            },
          ],
        });
        expect(jobs[0]?.concurrencyKey).toBe(libraryConcurrencyKey(library.id));
      } finally {
        await debouncer.close();
      }
    }));

  test("changes in two directories become two scan jobs", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await debouncer.submit("radarr", [
          {
            kind: "add",
            path: "/media/movies/Alien (1979)/Alien.mkv",
            providerIds: {},
          },
          {
            kind: "add",
            path: "/media/movies/Blade Runner (1982)/Blade Runner.mkv",
            providerIds: {},
          },
        ]);
        const jobs = await waitForScanJobs(db, 2);
        expect(jobs.map((job) => job.payload)).toEqual(
          expect.arrayContaining([
            {
              type: "scan",
              libraryId: library.id,
              path: "Alien (1979)",
              changes: [
                {
                  kind: "add",
                  rootId: library.rootId,
                  path: "Alien (1979)/Alien.mkv",
                  providerIds: {},
                },
              ],
            },
            {
              type: "scan",
              libraryId: library.id,
              path: "Blade Runner (1982)",
              changes: [
                {
                  kind: "add",
                  rootId: library.rootId,
                  path: "Blade Runner (1982)/Blade Runner.mkv",
                  providerIds: {},
                },
              ],
            },
          ]),
        );
        for (const job of jobs)
          expect(job.concurrencyKey).toBe(libraryConcurrencyKey(library.id));
      } finally {
        await debouncer.close();
      }
    }));

  test("close flushes pending changes once and stays idempotent", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 60_000 });
      await debouncer.submit("radarr", [
        {
          kind: "delete",
          path: "/media/movies/Alien (1979)",
          target: "item",
          providerIds: movieIds,
        },
      ]);
      await debouncer.close();
      await debouncer.close();
      const jobs = await listJobs(db, { type: "scan" });
      expect(jobs.map((job) => job.payload)).toEqual([
        {
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
          changes: [
            {
              kind: "delete",
              rootId: library.rootId,
              path: "Alien (1979)",
              target: "item",
              providerIds: movieIds,
            },
          ],
        },
      ]);
    }));

  test("a path binds its root, and a move between roots lands in the destination root", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (dir) => {
        const hq = join(dir, "hq");
        const transcoded = join(dir, "transcoded");
        const file = "Alien (1979)/Alien (1979).mkv";
        await mkdir(join(hq, dirname(file)), { recursive: true });
        await mkdir(join(transcoded, dirname(file)), { recursive: true });
        await createVideoFixture(join(hq, file));
        const library = await insertLibrary(db, "Movies", hq);
        const transcodedId = await addRoot(db, library.id, transcoded);
        await scanDirectory(db, library.id, dirname(file));
        const [before] = await db.select().from(files);
        if (!before) throw new Error("Alien was not scanned.");
        expect(before.rootId).toBe(library.rootId);

        await rename(join(hq, file), join(transcoded, file));
        const debouncer = createChangeDebouncer(db, { delayMs: 10 });
        await debouncer.submit("radarr", [
          {
            kind: "move",
            path: join(transcoded, file),
            previousPath: join(hq, file),
            providerIds: movieIds,
          },
        ]);
        await debouncer.close();
        const [job] = await listJobs(db, { type: "scan" });
        expect(job?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: dirname(file),
          changes: [
            {
              kind: "delete",
              rootId: library.rootId,
              path: file,
              target: "file",
              providerIds: {},
            },
            {
              kind: "add",
              rootId: transcodedId,
              path: file,
              providerIds: movieIds,
            },
          ],
        });

        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        const claimed = await queue.claim(["scan"]);
        if (!claimed) throw new Error("The scan was not queued.");
        await registry.run(claimed);
        await queue.complete(claimed);
        const after = await db.select().from(files);
        expect(after).toMatchObject([
          { rootId: transcodedId, path: file, itemId: before.itemId },
        ]);
      });
    }));

  test("close waits for a submission blocked on the libraries lock", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 60_000 });
      const second = createDatabase(url);
      let release = () => {};
      try {
        const locked = second.db.transaction(async (tx) => {
          await tx.execute(sql`lock table libraries in access exclusive mode`);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        });
        const lockDeadline = Date.now() + 2_000;
        for (;;) {
          const rows = await db.$client<{ count: number }[]>`
            select count(*)::integer as count from pg_locks
            where locktype = 'relation' and granted
              and mode = 'AccessExclusiveLock'
              and relation = 'libraries'::regclass`;
          if ((rows[0]?.count ?? 0) > 0) break;
          if (Date.now() >= lockDeadline) {
            throw new Error("Libraries lock was not observed.");
          }
          await Bun.sleep(10);
        }
        const submission = debouncer.submit("radarr", [
          {
            kind: "add",
            path: "/media/movies/Alien (1979)/Alien.mkv",
            providerIds: {},
          },
        ]);
        const deadline = Date.now() + 2_000;
        for (;;) {
          const rows = await db.$client<{ count: number }[]>`
            select count(*)::integer as count from pg_locks
            where locktype = 'relation' and not granted
              and relation = 'libraries'::regclass`;
          if ((rows[0]?.count ?? 0) > 0) break;
          if (Date.now() >= deadline) {
            throw new Error("Submit lock wait was not observed.");
          }
          await Bun.sleep(10);
        }
        let closeResolved = false;
        const closing = debouncer.close();
        void closing.then(
          () => {
            closeResolved = true;
          },
          () => {},
        );
        await Bun.sleep(50);
        expect(closeResolved).toBe(false);
        release();
        await submission;
        await closing;
        const found = await listJobs(db, { type: "scan" });
        expect(found).toHaveLength(1);
        expect(found[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
          changes: [
            {
              kind: "add",
              rootId: library.rootId,
              path: "Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ],
        });
        await locked;
      } finally {
        release();
        await second.close();
      }
    }));

  test("concurrent submissions append to the batch in call order", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 60_000 });
      const second = createDatabase(url);
      let release = () => {};
      try {
        const locked = second.db.transaction(async (tx) => {
          await tx.execute(sql`lock table libraries in access exclusive mode`);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        });
        const lockDeadline = Date.now() + 2_000;
        for (;;) {
          const rows = await db.$client<{ count: number }[]>`
            select count(*)::integer as count from pg_locks
            where locktype = 'relation' and granted
              and mode = 'AccessExclusiveLock'
              and relation = 'libraries'::regclass`;
          if ((rows[0]?.count ?? 0) > 0) break;
          if (Date.now() >= lockDeadline) {
            throw new Error("Libraries lock was not observed.");
          }
          await Bun.sleep(10);
        }
        const first = debouncer.submit("radarr", [
          {
            kind: "move",
            path: "/media/movies/Alien (1979)/Alien-B.mkv",
            previousPath: "/media/movies/Alien (1979)/Alien-A.mkv",
            providerIds: {},
          },
        ]);
        const secondSubmit = debouncer.submit("radarr", [
          {
            kind: "move",
            path: "/media/movies/Alien (1979)/Alien-C.mkv",
            previousPath: "/media/movies/Alien (1979)/Alien-B.mkv",
            providerIds: {},
          },
        ]);
        const deadline = Date.now() + 2_000;
        for (;;) {
          const rows = await db.$client<{ count: number }[]>`
            select count(*)::integer as count from pg_locks
            where locktype = 'relation' and not granted
              and relation = 'libraries'::regclass`;
          const count = rows[0]?.count ?? 0;
          if (count === 1) break;
          if (count > 1) {
            throw new Error(
              `Expected one blocked libraries query; found ${count}.`,
            );
          }
          if (Date.now() >= deadline) {
            throw new Error("Submit lock wait was not observed.");
          }
          await Bun.sleep(10);
        }
        release();
        await first;
        await secondSubmit;
        await debouncer.close();
        const found = await listJobs(db, { type: "scan" });
        expect(found).toHaveLength(1);
        expect(found[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
          changes: [
            {
              kind: "move",
              rootId: library.rootId,
              path: "Alien (1979)/Alien-B.mkv",
              previousPath: "Alien (1979)/Alien-A.mkv",
              providerIds: {},
            },
            {
              kind: "move",
              rootId: library.rootId,
              path: "Alien (1979)/Alien-C.mkv",
              previousPath: "Alien (1979)/Alien-B.mkv",
              providerIds: {},
            },
          ],
        });
        await locked;
      } finally {
        release();
        await second.close();
      }
    }));

  test("a failed timer flush retries the same ordered batch", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const errors: unknown[] = [];
      const debouncer = createChangeDebouncer(db, {
        delayMs: 30,
        onError: (error) => {
          errors.push(error);
        },
      });
      await debouncer.submit("radarr", [
        {
          kind: "add",
          path: "/media/movies/Alien (1979)/Alien.1080p.mkv",
          providerIds: {},
        },
        {
          kind: "delete",
          path: "/media/movies/Alien (1979)/Alien.720p.mkv",
          target: "file",
          providerIds: {},
        },
      ]);
      await db.execute(sql`alter table jobs rename to jobs_paused`);
      const deadline = Date.now() + 2_000;
      while (errors.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      await db.execute(sql`alter table jobs_paused rename to jobs`);
      const jobs = await waitForScanJobs(db, 1);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual({
        type: "scan",
        libraryId: library.id,
        path: "Alien (1979)",
        changes: [
          {
            kind: "add",
            rootId: library.rootId,
            path: "Alien (1979)/Alien.1080p.mkv",
            providerIds: {},
          },
          {
            kind: "delete",
            rootId: library.rootId,
            path: "Alien (1979)/Alien.720p.mkv",
            target: "file",
            providerIds: {},
          },
        ],
      });
      await debouncer.close();
    }));

  test("a permanent flush failure keeps reporting and close rejects", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await insertLibrary(db, "Movies", "/media/movies");
      const errors: unknown[] = [];
      const debouncer = createChangeDebouncer(db, {
        delayMs: 100,
        onError: (error) => {
          errors.push(error);
          throw new Error("Reporting failed.");
        },
      });
      await debouncer.submit("radarr", [
        {
          kind: "add",
          path: "/media/movies/Alien (1979)/Alien.mkv",
          providerIds: {},
        },
      ]);
      await db.execute(sql`drop table jobs`);
      const deadline = Date.now() + 2_000;
      while (errors.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      await expect(debouncer.close()).rejects.toThrow();
    }));

  test("a debouncer defect rejects instead of answering 400", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const { token } = await createApiKey(db, admin.id, "Radarr");
      const failing = {
        submit: (_source: "sonarr" | "radarr", _changes: ChangeEvent[]) =>
          Promise.reject(new Error("database unavailable")),
        close: () => Promise.resolve(),
      };
      const handler = createServarrWebhookHandler(db, failing);
      const request = new Request(
        `http://thalia.test/api/webhooks/radarr/${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(await loadFixture("radarr-download.json")),
        },
      );
      await expect(handler(request)).rejects.toThrow("database unavailable");
    }));

  test("unmatched paths and cross-library moves reject without jobs", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await insertLibrary(db, "Movies", "/media/movies");
      await insertLibrary(db, "More Movies", "/media/other");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await expect(
          debouncer.submit("radarr", [
            {
              kind: "move",
              path: "/media/movies/Alien (1979)/Alien.mkv",
              previousPath: "/media/other/Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        await expect(
          debouncer.submit("radarr", [
            {
              kind: "add",
              path: "/downloads/Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        await expect(
          debouncer.submit("radarr", [
            { kind: "add", path: "Alien (1979)/Alien.mkv", providerIds: {} },
          ]),
        ).rejects.toThrow();
        await expect(
          debouncer.submit("sonarr", [
            {
              kind: "add",
              path: "/media/movies/Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        expect(await listJobs(db, { type: "scan" })).toEqual([]);
      } finally {
        await debouncer.close();
      }
    }));

  test("changes whose scan folder is the library root queue a root scan", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        for (const change of [
          {
            kind: "delete",
            path: "/media/movies",
            target: "item",
            providerIds: movieIds,
          },
          { kind: "add", path: "/media/movies/Alien.mkv", providerIds: {} },
        ] satisfies ChangeEvent[])
          await debouncer.submit("radarr", [change]);
      } finally {
        await debouncer.close();
      }
      const jobs = await listJobs(db, { type: "scan" });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toMatchObject({
        libraryId: library.id,
        path: ".",
      });
    }));

  test("only a move into another Show queues its source folder", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const episodes = [
          "Show A/Season 01/Show A S01E01.mkv",
          "Show A/Season 01/Show A S01E02.mkv",
          "Show B/Season 01/Show B S01E01.mkv",
        ];
        for (const path of episodes) {
          await mkdir(join(root, dirname(path)), { recursive: true });
          await createVideoFixture(join(root, path));
        }
        const library = await insertLibrary(db, "Shows", root, "shows");
        await scanShowDirectory(db, library.id, "Show A");
        await scanShowDirectory(db, library.id, "Show B");
        const intoShow = {
          kind: "move",
          path: "Show B/Season 01/Show B S01E03.mkv",
          previousPath: "Show A/Season 01/Show A S01E01.mkv",
        } as const;
        const intoFolder = {
          kind: "move",
          path: "Show C/Season 01/Show A S01E02.mkv",
          previousPath: "Show A/Season 01/Show A S01E02.mkv",
        } as const;
        const providerIds = { tvdb: "2" };
        const { rootId } = library;
        const debouncer = createChangeDebouncer(db, { delayMs: 10 });
        try {
          await debouncer.submit(
            "sonarr",
            [intoShow, intoFolder].map((move) => ({
              ...move,
              path: join(root, move.path),
              previousPath: join(root, move.previousPath),
              providerIds,
            })),
          );
          await debouncer.close();
          const jobs = await listJobs(db, { type: "scan" });
          expect(jobs.map((job) => job.payload)).toHaveLength(3);
          expect(jobs.map((job) => job.payload)).toEqual(
            expect.arrayContaining(
              [
                ["Show A", { ...intoShow, rootId, providerIds: {} }],
                ["Show B", { ...intoShow, rootId, providerIds }],
                ["Show C", { ...intoFolder, rootId, providerIds }],
              ].map(([path, change]) => ({
                type: "scan",
                libraryId: library.id,
                path,
                changes: [change],
              })),
            ),
          );
        } finally {
          await debouncer.close();
        }
      });
    }));

  test("the api role accepts api-key webhooks and rejects other callers", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const { token: sonarrToken } = await createApiKey(db, admin.id, "Sonarr");
      const { token: radarrToken } = await createApiKey(db, admin.id, "Radarr");
      const { token: sessionToken } = await login(
        db,
        { username: "admin", password: "admin-pass", ...device },
        "127.0.0.1",
      );
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token: viewerToken } = await createApiKey(
        db,
        viewer.id,
        "Viewer",
      );
      const movies = await insertLibrary(db, "Movies", "/media/movies");
      const shows = await insertLibrary(db, "Shows", "/media/shows", "shows");
      const server = await startThalia("api", {
        databaseUrl: url,
        port: 0,
        changeOptions: { delayMs: 10 },
      });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const post = (provider: string, secret: string, body: unknown) =>
          fetch(`${base}/api/webhooks/${provider}/${secret}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          });

        const radarrPayload = await loadFixture("radarr-download.json");
        const accepted = await post("radarr", radarrToken, radarrPayload);
        expect(accepted.status).toBe(202);
        expect(await accepted.json()).toEqual({ accepted: 2 });
        const jobs = await waitForScanJobs(db, 1);
        expect(jobs[0]?.payload).toEqual({
          type: "scan",
          libraryId: movies.id,
          path: "Alien (1979) {tmdb-348}",
          changes: [
            {
              kind: "add",
              rootId: movies.rootId,
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
              providerIds: movieIds,
            },
            {
              kind: "delete",
              rootId: movies.rootId,
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [WEBDL-720p].mkv",
              target: "file",
              providerIds: movieIds,
            },
          ],
        });
        expect(jobs[0]?.concurrencyKey).toBe(libraryConcurrencyKey(movies.id));

        expect((await post("radarr", sonarrToken, radarrPayload)).status).toBe(
          202,
        );
        expect(
          (
            await post(
              "sonarr",
              sonarrToken,
              await loadFixture("sonarr-download.json"),
            )
          ).status,
        ).toBe(202);
        const all = await waitForScanJobs(db, 2);
        expect(all).toHaveLength(2);
        expect(
          all.some(
            (job) =>
              job.payload.type === "scan" &&
              job.payload.libraryId === shows.id &&
              job.payload.path === "Foundation",
          ),
        ).toBe(true);

        const wrongSecret = "x".repeat(43);
        for (const provider of ["sonarr", "radarr"]) {
          const response = await post(provider, wrongSecret, radarrPayload);
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({
            error: {
              code: "UNAUTHENTICATED",
              message: "Authentication required.",
            },
          });
        }
        expect((await post("radarr", sessionToken, radarrPayload)).status).toBe(
          401,
        );
        expect((await post("radarr", viewerToken, radarrPayload)).status).toBe(
          403,
        );

        const malformed = await post("radarr", radarrToken, {
          eventType: "Download",
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid webhook payload.",
          },
        });
        expect((await post("radarr", radarrToken, "{not json")).status).toBe(
          400,
        );

        const get = await fetch(`${base}/api/webhooks/radarr/${radarrToken}`);
        expect(get.status).toBe(405);
        expect(get.headers.get("allow")).toBe("POST");

        expect((await fetch(`${base}/api/libraries`)).status).toBe(401);
      } finally {
        await server.stop();
      }
    }));

  test("a Sonarr download queues a show scan that runs end to end", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const seasonDir = join(root, "Foundation", "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const episodePath = join(seasonDir, "Foundation S01E01.mkv");
        await createVideoFixture(episodePath);
        const shows = await insertLibrary(db, "Shows", root, "shows");
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const { token } = await createApiKey(db, admin.id, "Sonarr");
        const server = await startThalia("api", {
          databaseUrl: url,
          port: 0,
          changeOptions: { delayMs: 10 },
        });
        let debouncedJobId: string | undefined;
        try {
          // Finish startup repair before testing a new webhook's change payload.
          await waitForScanJobs(db, 1);
          const startupQueue = createJobQueue(db);
          const startupRegistry = createJobRegistry();
          registerLibraryJobs(db, startupRegistry);
          const startupJob = await startupQueue.claim(["scan"]);
          if (!startupJob) throw new Error("Startup repair was not claimed.");
          await startupRegistry.run(startupJob);
          await startupQueue.complete(startupJob);
          const response = await fetch(
            `http://127.0.0.1:${server.apiServer?.port}/api/webhooks/sonarr/${token}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                eventType: "Download",
                series: {
                  path: join(root, "Foundation"),
                  tvdbId: 366972,
                  tmdbId: 106379,
                  imdbId: "tt0804484",
                },
                episodeFile: { path: episodePath },
              }),
            },
          );
          expect(response.status).toBe(202);
          expect(await response.json()).toEqual({ accepted: 1 });
          const deadline = Date.now() + 5_000;
          let job: Job | undefined;
          for (;;) {
            job = (await listJobs(db, { state: "queued", type: "scan" })).find(
              (row) =>
                row.payload.type === "scan" &&
                row.payload.libraryId === shows.id &&
                row.payload.path === "Foundation" &&
                row.payload.changes !== undefined,
            );
            if (job !== undefined) break;
            if (Date.now() >= deadline) {
              throw new Error("Timed out waiting for the debounced scan job.");
            }
            await Bun.sleep(10);
          }
          expect(job.payload).toEqual({
            type: "scan",
            libraryId: shows.id,
            path: "Foundation",
            changes: [
              {
                kind: "add",
                rootId: shows.rootId,
                path: "Foundation/Season 01/Foundation S01E01.mkv",
                providerIds: {
                  imdb: "tt0804484",
                  tmdb: "106379",
                  tvdb: "366972",
                },
              },
            ],
          });
          expect(job.concurrencyKey).toBe(libraryConcurrencyKey(shows.id));
          debouncedJobId = job.id;
        } finally {
          await server.stop();
        }

        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        let ranDebounced = false;
        for (;;) {
          const claimed = await queue.claim(["scan"]);
          if (!claimed) break;
          await registry.run(claimed);
          await queue.complete(claimed);
          if (claimed.id === debouncedJobId) ranDebounced = true;
        }
        expect(ranDebounced).toBe(true);

        const itemRows = await db.select().from(items);
        const show = itemRows.find((row) => row.kind === "show");
        const season = itemRows.find((row) => row.kind === "season");
        const episode = itemRows.find((row) => row.kind === "episode");
        expect(show?.canonicalFolder).toBe("Foundation");
        expect(season?.parentId).toBe(show?.id);
        expect(episode?.parentId).toBe(season?.id);
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toHaveLength(1);
        const idRows = await db
          .select()
          .from(providerIds)
          .orderBy(asc(providerIds.provider));
        expect(
          idRows.map((row) => [row.provider, row.value, row.itemId]),
        ).toEqual([
          ["imdb", "tt0804484", show?.id ?? null],
          ["tmdb", "106379", show?.id ?? null],
          ["tvdb", "366972", show?.id ?? null],
        ]);
      });
    }));

  test("a watcher change in a root-anchored Show queues a root scan that succeeds", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (dir) => {
        const root = join(dir, "Breaking Bad (2008)");
        await mkdir(join(root, "Season 1"), { recursive: true });
        const episode = "Season 1/Breaking Bad - S01E01.mkv";
        await createVideoFixture(join(root, episode));
        const library = await insertLibrary(db, "Shows", root, "shows");
        const debouncer = createChangeDebouncer(db, { delayMs: 10 });
        try {
          await debouncer.submitWatched(library.rootId, [
            { kind: "add", path: episode },
          ]);
        } finally {
          await debouncer.close();
        }
        const jobs = await listJobs(db, { type: "scan" });
        expect(jobs.map((job) => job.payload)).toEqual([
          {
            type: "scan",
            libraryId: library.id,
            path: ".",
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: episode,
                providerIds: {},
              },
            ],
          },
        ]);

        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        const claimed = await queue.claim(["scan"]);
        if (!claimed) throw new Error("Root scan was not claimed.");
        await registry.run(claimed);
        const show = (await db.select().from(items)).find(
          (row) => row.kind === "show",
        );
        expect(show).toMatchObject({
          title: "Breaking Bad",
          canonicalFolder: ".",
          titleKey: "breaking bad (2008)",
        });
      });
    }));

  test("a Sonarr webhook inside a root-anchored show queues a root scan", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (dir) => {
        const root = join(dir, "Breaking Bad (2008)");
        await mkdir(join(root, "Season 1"), { recursive: true });
        const episode = "Season 1/Breaking Bad - S01E02.mkv";
        await createVideoFixture(join(root, episode));
        const library = await insertLibrary(db, "Shows", root, "shows");
        const debouncer = createChangeDebouncer(db, { delayMs: 10 });
        try {
          await debouncer.submit("sonarr", [
            {
              kind: "add",
              path: join(root, episode),
              providerIds: { tvdb: "81189" },
            },
          ]);
        } finally {
          await debouncer.close();
        }
        const jobs = await listJobs(db, { type: "scan" });
        expect(jobs.map((job) => job.payload)).toEqual([
          {
            type: "scan",
            libraryId: library.id,
            path: ".",
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: episode,
                providerIds: { tvdb: "81189" },
              },
            ],
          },
        ]);
      });
    }));
});
