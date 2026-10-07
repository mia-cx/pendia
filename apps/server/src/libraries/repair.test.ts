import { describe, expect, test } from "bun:test";
import { mkdir, rename, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { files, items, jobs, streams, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { createJobQueue, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
import { createLibraryRepair } from "./repair.ts";
import { scanDirectory, scanShowDirectory } from "./scan.ts";
import { insertLibraries } from "./testing.ts";

const folder = "Alien (1979) {tmdb-348}";
const file1080 = `${folder}/Alien.1080p.mkv`;
const file2160 = `${folder}/Alien.2160p {edition-Director's Cut}.mkv`;

async function insertLibrary(
  db: Database,
  rootPath: string,
  medium: "movies" | "shows" = "movies",
) {
  const [library] = await insertLibraries(db, {
    name: "Movies",
    medium,
    rootPath,
  });
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

async function drainScanJobs(db: Database) {
  const queue = createJobQueue(db);
  const registry = createJobRegistry();
  registerLibraryJobs(db, registry);
  for (;;) {
    const claimed = await queue.claim(["scan"]);
    if (!claimed) return;
    await registry.run(claimed);
    await queue.complete(claimed);
  }
}

async function waitForScanJobs(db: Database, count: number) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = await listJobs(db, { state: "queued", type: "scan" });
    if (found.length >= count) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${count} queued scan jobs; found ${found.length}.`,
      );
    }
    await Bun.sleep(10);
  }
}

async function waitForRepairScan(
  db: Database,
  libraryId: string,
  path: string,
) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = await listJobs(db, { state: "queued", type: "scan" });
    if (
      found.some(
        (job) =>
          job.payload.type === "scan" &&
          job.payload.libraryId === libraryId &&
          job.payload.path === path,
      )
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a repair scan of ${path}.`);
    }
    await Bun.sleep(10);
  }
}

describe.skipIf(!databaseUrl)("library repair", () => {
  test("startup resumes an interrupted run without repeating completed or pending folders", () =>
    withDatabase(async (db, url) => {
      await withVideoFixture(async (root) => {
        for (const path of [
          "Loose (2000).mkv",
          file1080,
          "Heat (1995)/Heat.mkv",
        ]) {
          await mkdir(join(root, path, ".."), { recursive: true });
          await createVideoFixture(join(root, path));
        }
        const library = await insertLibrary(db, root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        const parent = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "." },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const rootJob = await queue.claim(["scan"]);
        if (!rootJob) throw new Error("Root scan was not claimed.");
        await registry.run(rootJob);
        await queue.complete(rootJob);
        const completed = await queue.claim(["scan"]);
        if (!completed)
          throw new Error("First directory scan was not claimed.");
        await registry.run(completed);
        await queue.complete(completed);
        const interrupted = await queue.claim(["scan"]);
        if (!interrupted) throw new Error("Interrupted scan was not claimed.");
        await db
          .update(jobs)
          .set({
            leaseExpiresAt: sql`statement_timestamp() - interval '1 second'`,
          })
          .where(eq(jobs.id, interrupted.id));
        const before = await listJobs(db, { type: "scan" });
        expect(before).toHaveLength(4);
        const errors: unknown[] = [];
        const server = await startThalia("api", {
          databaseUrl: url,
          port: 0,
          repairOptions: {
            intervalMs: 40,
            onError: (error) => errors.push(error),
          },
        });
        try {
          // Also await a fresh controller's pass so the assertion cannot beat startup repair.
          const restartedRepair = createLibraryRepair(db);
          expect(await restartedRepair.run()).toBe(0);
          expect(await listJobs(db, { type: "scan" })).toEqual(before);
          await drainScanJobs(db);
          expect(await restartedRepair.run()).toBe(0);
          const finished = await listJobs(db, { type: "scan" });
          expect(finished.map((job) => job.id)).toEqual(
            before.map((job) => job.id),
          );
          expect(finished.every((job) => job.state === "completed")).toBe(true);
          expect(
            finished
              .filter((job) => job.id !== parent.id)
              .map((job) =>
                job.payload.type === "scan" ? job.payload.runId : undefined,
              ),
          ).toEqual([parent.id, parent.id, parent.id]);
          expect(errors).toEqual([]);
        } finally {
          await server.stop();
        }
      });
    }));

  test.each(["queued", "running"] as const)(
    "repair defers to a %s whole-library job before fan-out",
    (state) =>
      withDatabase(async (db) => {
        await withVideoFixture(async (root) => {
          await mkdir(join(root, folder));
          await createVideoFixture(join(root, file1080));
          const library = await insertLibrary(db, root);
          const queue = createJobQueue(db);
          const parent = await queue.enqueue({
            type: "scan",
            libraryId: library.id,
            path: ".",
          });
          if (state === "running") await queue.claim(["scan"]);
          expect(await createLibraryRepair(db).run()).toBe(0);
          expect(
            (await listJobs(db, { type: "scan" })).map((job) => job.id),
          ).toEqual([parent.id]);
        });
      }),
  );

  test("a fresh repair reuses another producer's scan and retries it if it fails", () =>
    withDatabase(async (db) => {
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder));
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        const queue = createJobQueue(db);
        const original = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: folder },
          { maxAttempts: 1 },
        );
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(0);
        const claimed = await queue.claim(["scan"]);
        if (!claimed) throw new Error("Existing scan was not claimed.");
        await queue.fail(claimed, new Error("Interrupted."));
        expect(await repair.run()).toBe(1);
        const scans = await listJobs(db, { type: "scan" });
        expect(scans).toHaveLength(2);
        expect(scans[0]?.id).not.toBe(original.id);
        expect(scans[0]?.state).toBe("queued");
      });
    }));

  test("restart repair scans a completed folder that gained a file while its sibling waits", () =>
    withDatabase(async (db) => {
      await withVideoFixture(async (root) => {
        for (const path of [file1080, "Heat (1995)/Heat.mkv"]) {
          await mkdir(join(root, path, ".."), { recursive: true });
          await createVideoFixture(join(root, path));
        }
        const library = await insertLibrary(db, root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue({ type: "scan", libraryId: library.id, path: "." });
        for (let index = 0; index < 2; index++) {
          const job = await queue.claim(["scan"]);
          if (!job) throw new Error("Scan was not claimed.");
          await registry.run(job);
          await queue.complete(job);
        }
        await createVideoFixture(join(root, file2160));
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);
        await drainScanJobs(db);
        expect(
          (await db.select().from(files)).map((file) => file.path),
        ).toContain(file2160);
        expect(await repair.run()).toBe(0);
      });
    }));

  test("a directory change queues a scan that imports the new file", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const library = await insertLibrary(db, root);
        const repair = createLibraryRepair(db);
        const first = repair.run();
        expect(repair.run()).toBe(first);
        expect(await first).toBe(0);

        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        expect(await repair.run()).toBe(1);

        const jobs = await listJobs(db, { type: "scan" });
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: folder,
          reconcileMissing: true,
        });
        expect(jobs[0]?.concurrencyKey).toBe(libraryConcurrencyKey(library.id));
        await drainScanJobs(db);
        const itemRows = await db.select().from(items);
        expect(itemRows).toHaveLength(1);
        expect(itemRows[0]).toMatchObject({
          libraryId: library.id,
          kind: "movie",
          canonicalFolder: folder,
        });
        expect(await db.select().from(versions)).toHaveLength(1);
      });
    }));

  test("a removed directory queues a scan that reconciles the stale Item", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);
        expect(await db.select().from(items)).toHaveLength(1);

        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);
        await drainScanJobs(db);
        expect(await db.select().from(items)).toHaveLength(1);

        await rm(join(root, folder), { recursive: true });
        expect(await repair.run()).toBe(1);
        await drainScanJobs(db);
        expect(await db.select().from(items)).toEqual([]);
        expect(await db.select().from(versions)).toEqual([]);
        expect(await db.select().from(files)).toEqual([]);
        expect(await db.select().from(streams)).toEqual([]);
      });
    }));

  test("an unchanged run and a file touch enqueue nothing", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        await insertLibrary(db, root);
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);
        expect(await repair.run()).toBe(0);
        const touched = new Date("2026-02-03T00:00:00Z");
        await utimes(join(root, file1080), touched, touched);
        expect(await repair.run()).toBe(0);
      });
    }));

  test("a queued repair scan suppresses duplicates until it completes", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        await insertLibrary(db, root);
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);

        await createVideoFixture(join(root, file2160));
        expect(await repair.run()).toBe(0);
        expect(
          await listJobs(db, { state: "queued", type: "scan" }),
        ).toHaveLength(1);

        await drainScanJobs(db);
        expect(await repair.run()).toBe(1);
        await drainScanJobs(db);
        expect(await repair.run()).toBe(0);
        expect(await db.select().from(items)).toHaveLength(1);
        expect(await db.select().from(versions)).toHaveLength(2);
      });
    }));

  test("a failed repair scan is re-enqueued for the unchanged directory", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);

        const queue = createJobQueue(db);
        const claimed = await queue.claim();
        if (!claimed) throw new Error("Repair scan was not claimed.");
        await db
          .update(jobs)
          .set({ state: "failed" })
          .where(eq(jobs.id, claimed.id));

        expect(await repair.run()).toBe(1);
        const queued = await listJobs(db, { state: "queued", type: "scan" });
        expect(queued).toHaveLength(1);
        expect(queued[0]?.id).not.toBe(claimed.id);
        expect(queued[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: folder,
          reconcileMissing: true,
        });
      });
    }));

  test("a missing root skips the library and keeps its snapshot", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        await insertLibrary(db, root);
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);

        const moved = `${root}-missing`;
        await rename(root, moved);
        expect(await repair.run()).toBe(0);
        expect(
          await listJobs(db, { state: "queued", type: "scan" }),
        ).toHaveLength(1);

        await rename(moved, root);
        expect(await repair.run()).toBe(0);
        expect(
          await listJobs(db, { state: "queued", type: "scan" }),
        ).toHaveLength(1);
      });
    }));

  test("start runs immediately then on the interval until stop", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        await insertLibrary(db, root);
        const errors: unknown[] = [];
        const repair = createLibraryRepair(db, {
          intervalMs: 40,
          onError: (error) => {
            errors.push(error);
          },
        });
        await createLibraryRepair(db).stop();
        repair.start();
        repair.start();
        try {
          await waitForScanJobs(db, 1);
          await drainScanJobs(db);
          await createVideoFixture(join(root, file2160));
          await waitForScanJobs(db, 1);
        } finally {
          await repair.stop();
          await repair.stop();
        }
        repair.start();
        const baseline = await listJobs(db, {
          state: "queued",
          type: "scan",
        });
        await createVideoFixture(join(root, `${folder}/Alien.720p.mkv`));
        await Bun.sleep(150);
        expect(
          await listJobs(db, { state: "queued", type: "scan" }),
        ).toHaveLength(baseline.length);
        expect(baseline.length).toBeGreaterThanOrEqual(1);
        expect(errors).toEqual([]);
      });
    }));

  test("two controllers on one database elect a single startup leader", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        const second = createDatabase(url);
        const errors: unknown[] = [];
        try {
          const first = createLibraryRepair(db, {
            intervalMs: 60_000,
            onError: (error) => {
              errors.push(error);
            },
          });
          const contender = createLibraryRepair(second.db, {
            intervalMs: 60_000,
            onError: (error) => {
              errors.push(error);
            },
          });
          try {
            first.start();
            contender.start();
            await waitForScanJobs(db, 1);
            await Bun.sleep(150);
            const found = await listJobs(db, { type: "scan" });
            expect(found).toHaveLength(1);
            expect(found[0]?.payload).toEqual({
              type: "scan",
              libraryId: library.id,
              path: folder,
              reconcileMissing: true,
            });
            expect(errors).toEqual([]);
          } finally {
            await first.stop();
            await contender.stop();
          }
        } finally {
          await second.close();
        }
      });
    }));

  test("startThalia runs the startup pass and the interval until stop", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        const server = await startThalia("api", {
          databaseUrl: url,
          port: 0,
          repairOptions: { intervalMs: 40 },
        });
        try {
          await waitForRepairScan(db, library.id, folder);
          const second = "Blade Runner (1982) {tmdb-78}";
          await mkdir(join(root, second), { recursive: true });
          await createVideoFixture(
            join(root, `${second}/Blade.Runner.1080p.mkv`),
          );
          await waitForRepairScan(db, library.id, second);
        } finally {
          await server.stop();
        }
        const queuedPaths = async () =>
          (await listJobs(db, { state: "queued", type: "scan" }))
            .filter(
              (job) =>
                job.payload.type === "scan" &&
                job.payload.libraryId === library.id,
            )
            .map((job) => (job.payload.type === "scan" ? job.payload.path : ""))
            .sort();
        const baseline = await queuedPaths();
        expect(baseline).toContain("Alien (1979) {tmdb-348}");
        expect(baseline).toContain("Blade Runner (1982) {tmdb-78}");
        const third = "Cars (2006) {tmdb-920}";
        await mkdir(join(root, third), { recursive: true });
        await createVideoFixture(join(root, `${third}/Cars.1080p.mkv`));
        await Bun.sleep(150);
        expect(await queuedPaths()).toEqual(baseline);
      });
    }));

  test("a show directory change queues a show scan that imports the episode", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const library = await insertLibrary(db, root, "shows");
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(0);

        const seasonDir = join(root, "Foundation", "Season 01");
        await mkdir(seasonDir, { recursive: true });
        await createVideoFixture(join(seasonDir, "Foundation S01E01.mkv"));
        expect(await repair.run()).toBe(1);

        const jobRows = await listJobs(db, { type: "scan" });
        expect(jobRows).toHaveLength(1);
        expect(jobRows[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: "Foundation",
          reconcileMissing: true,
        });
        await drainScanJobs(db);
        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.kind).sort()).toEqual([
          "episode",
          "season",
          "show",
        ]);
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toHaveLength(1);
      });
    }));

  test("a removed season queues the top-level show scan", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, "Foundation", "Season 01"), {
          recursive: true,
        });
        await mkdir(join(root, "Foundation", "Season 02"), {
          recursive: true,
        });
        await createVideoFixture(
          join(root, "Foundation/Season 01/Foundation S01E01.mkv"),
        );
        await createVideoFixture(
          join(root, "Foundation/Season 02/Foundation S02E01.mkv"),
        );
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        expect(await db.select().from(items)).toHaveLength(5);

        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);
        await drainScanJobs(db);
        expect(await repair.run()).toBe(0);

        await rm(join(root, "Foundation", "Season 02"), { recursive: true });
        expect(await repair.run()).toBe(1);
        const jobRows = await listJobs(db, { state: "queued", type: "scan" });
        expect(jobRows.map((job) => job.payload)).toEqual([
          {
            type: "scan",
            libraryId: library.id,
            path: "Foundation",
            reconcileMissing: true,
          },
        ]);
        await drainScanJobs(db);

        const itemRows = await db.select().from(items);
        const seasonRows = itemRows.filter((row) => row.kind === "season");
        expect(
          itemRows.find((row) => row.kind === "show")?.canonicalFolder,
        ).toBe("Foundation");
        expect(seasonRows.map((row) => row.canonicalFolder)).toEqual([
          "Foundation/Season 01",
        ]);
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toHaveLength(1);
        expect(await repair.run()).toBe(0);
      });
    }));

  test("a failed show repair retry acknowledges the removed season", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, "Foundation", "Season 01"), {
          recursive: true,
        });
        await mkdir(join(root, "Foundation", "Season 02"), {
          recursive: true,
        });
        await createVideoFixture(
          join(root, "Foundation/Season 01/Foundation S01E01.mkv"),
        );
        await createVideoFixture(
          join(root, "Foundation/Season 02/Foundation S02E01.mkv"),
        );
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);
        await drainScanJobs(db);
        expect(await repair.run()).toBe(0);

        await createVideoFixture(
          join(root, "Foundation/Season 02/Foundation S02E02.mkv"),
        );
        expect(await repair.run()).toBe(1);
        const queue = createJobQueue(db);
        // Show scans also queue a provider-fetch for the pending Show.
        const claimed = await queue.claim(["scan"]);
        if (!claimed) throw new Error("Repair scan was not claimed.");
        await db
          .update(jobs)
          .set({ state: "failed" })
          .where(eq(jobs.id, claimed.id));

        await rm(join(root, "Foundation", "Season 02"), { recursive: true });
        expect(await repair.run()).toBe(1);
        const queued = await listJobs(db, { state: "queued", type: "scan" });
        expect(queued.map((job) => job.payload)).toEqual([
          {
            type: "scan",
            libraryId: library.id,
            path: "Foundation",
            reconcileMissing: true,
          },
        ]);
        await drainScanJobs(db);
        expect(await repair.run()).toBe(0);
      });
    }));

  test("changed season directories share one show scan acknowledgement", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, "Foundation", "Season 01"), {
          recursive: true,
        });
        await mkdir(join(root, "Foundation", "Season 02"), {
          recursive: true,
        });
        await createVideoFixture(
          join(root, "Foundation/Season 01/Foundation S01E01.mkv"),
        );
        await createVideoFixture(
          join(root, "Foundation/Season 02/Foundation S02E01.mkv"),
        );
        const library = await insertLibrary(db, root, "shows");
        const repair = createLibraryRepair(db);
        expect(await repair.run()).toBe(1);
        await drainScanJobs(db);
        expect(await repair.run()).toBe(0);

        await createVideoFixture(
          join(root, "Foundation/Season 01/Foundation S01E02.mkv"),
        );
        await createVideoFixture(
          join(root, "Foundation/Season 02/Foundation S02E02.mkv"),
        );
        expect(await repair.run()).toBe(1);
        const jobRows = await listJobs(db, { state: "queued", type: "scan" });
        expect(jobRows).toHaveLength(1);
        expect(jobRows[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: "Foundation",
          reconcileMissing: true,
        });
        await drainScanJobs(db);
        expect(await repair.run()).toBe(0);
      });
    }));

  test("invalid intervals reject", () =>
    withDatabase(async (db) => {
      for (const intervalMs of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        2_147_483_648,
      ]) {
        expect(() => createLibraryRepair(db, { intervalMs })).toThrow();
      }
    }));
});
