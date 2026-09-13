import { describe, expect, test } from "bun:test";
import { mkdir, rename, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  items,
  jobs,
  libraries,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { createJobQueue, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
import { createLibraryRepair } from "./repair.ts";
import { scanDirectory } from "./scan.ts";

const folder = "Alien (1979) {tmdb-348}";
const file1080 = `${folder}/Alien.1080p.mkv`;
const file2160 = `${folder}/Alien.2160p {edition-Director's Cut}.mkv`;

async function insertLibrary(db: Database, rootPath: string) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath })
    .returning();
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

  test("startPendia runs the startup pass and the interval until stop", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        const server = await startPendia("api", {
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
