import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { events, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";

async function withTempRoot<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pendia-library-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function insertLibrary(
  db: Database,
  name: string,
  rootPath: string,
  medium: "movies" | "shows" = "movies",
) {
  const [library] = await db
    .insert(libraries)
    .values({ name, medium, rootPath })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

async function expectHandlerError(
  promise: Promise<unknown>,
  code: AuthError["code"],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AuthError ${code}.`);
}

describe.skipIf(!databaseUrl)("library scan jobs", () => {
  test("a root job fans out directory scans serialized per library", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (rootA) =>
        withTempRoot(async (rootB) => {
          for (const folder of ["Alien (1979)", "Blade Runner (1982)"]) {
            await mkdir(join(rootA, folder), { recursive: true });
            await writeFile(join(rootA, folder, "movie.mkv"), "dummy");
          }
          await mkdir(join(rootA, "extras"), { recursive: true });
          await writeFile(join(rootA, "extras", "tempting.mkv"), "dummy");
          const libraryA = await insertLibrary(db, "Movies", rootA);
          const libraryB = await insertLibrary(db, "Other", rootB);
          const queue = createJobQueue(db);
          const registry = createJobRegistry();
          registerLibraryJobs(db, registry);

          const rootJob = await queue.enqueue(
            { type: "scan", libraryId: libraryA.id, path: "." },
            { concurrencyKey: libraryConcurrencyKey(libraryA.id) },
          );
          const claimed = await queue.claim();
          expect(claimed?.id).toBe(rootJob.id);
          await registry.run(claimed ?? rootJob);

          const fanned = await listJobs(db, { state: "queued" });
          expect(fanned.map((job) => job.payload)).toEqual([
            {
              type: "scan",
              libraryId: libraryA.id,
              path: "Blade Runner (1982)",
              runId: rootJob.id,
            },
            {
              type: "scan",
              libraryId: libraryA.id,
              path: "Alien (1979)",
              runId: rootJob.id,
            },
          ]);
          for (const job of fanned) {
            expect(job.concurrencyKey).toBe(libraryConcurrencyKey(libraryA.id));
          }

          expect(await queue.claim()).toBeUndefined();

          const rootJobB = await queue.enqueue(
            { type: "scan", libraryId: libraryB.id, path: "." },
            { concurrencyKey: libraryConcurrencyKey(libraryB.id) },
          );
          const claimedB = await queue.claim();
          expect(claimedB?.id).toBe(rootJobB.id);

          await queue.complete(claimed ?? rootJob);
          const first = await queue.claim();
          expect(first?.payload).toEqual({
            type: "scan",
            libraryId: libraryA.id,
            path: "Alien (1979)",
            runId: rootJob.id,
          });
          expect(await queue.claim()).toBeUndefined();
          await queue.complete(first ?? rootJob);
          const second = await queue.claim();
          expect(second?.payload).toEqual({
            type: "scan",
            libraryId: libraryA.id,
            path: "Blade Runner (1982)",
            runId: rootJob.id,
          });
        }),
      );
    }));

  test("rolls back partial fan-out before retrying a root scan", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        for (const folder of ["Alien (1979)", "Blade Runner (1982)"]) {
          await mkdir(join(root, folder));
          await writeFile(join(root, folder, "movie.mkv"), "dummy");
        }
        const library = await insertLibrary(db, "Movies", root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        const rootJob = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "." },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim();
        if (!claimed) throw new Error("Root job was not claimed.");
        await db.execute(
          sql`alter table jobs add constraint reject_second_directory check (payload ->> 'path' is distinct from 'Blade Runner (1982)')`,
        );
        await expect(registry.run(claimed)).rejects.toThrow();
        expect(await listJobs(db, { state: "queued" })).toHaveLength(0);
        await db.execute(
          sql`alter table jobs drop constraint reject_second_directory`,
        );
        await registry.run(claimed);
        const children = await listJobs(db, { state: "queued" });
        expect(children.map((job) => job.payload)).toEqual([
          {
            type: "scan",
            libraryId: library.id,
            path: "Blade Runner (1982)",
            runId: rootJob.id,
          },
          {
            type: "scan",
            libraryId: library.id,
            path: "Alien (1979)",
            runId: rootJob.id,
          },
        ]);
        expect(
          children.every(
            (job) => job.concurrencyKey === libraryConcurrencyKey(library.id),
          ),
        ).toBe(true);
      });
    }));

  test("an empty library scan publishes one library.changed event", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const library = await insertLibrary(db, "Movies", root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "." },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim();
        if (!claimed) throw new Error("Root job was not claimed.");
        await registry.run(claimed);
        const published = await db.select().from(events);
        expect(published).toMatchObject([
          {
            kind: "library.changed",
            payload: { kind: "library.changed", libraryId: library.id },
          },
        ]);
        expect(await listJobs(db, { state: "queued" })).toHaveLength(0);
      });
    }));

  test("a missing library rejects", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const registry = createJobRegistry();
      registerLibraryJobs(db, registry);
      const libraryId = Bun.randomUUIDv7();
      const job = await queue.enqueue(
        { type: "scan", libraryId, path: "." },
        { concurrencyKey: libraryConcurrencyKey(libraryId) },
      );
      const claimed = await queue.claim();
      if (!claimed) throw new Error("Job was not claimed.");
      await expectHandlerError(registry.run(claimed), "NOT_FOUND");
      await queue.complete(claimed);
      expect(job.id).toBe(claimed.id);
    }));

  test("a shows root job fans out once per canonical Show folder", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const tree: Record<string, string[]> = {
          "A Show (2020)/Season 01": [
            "A Show S01E01.mkv",
            "A Show S01E02-E03.mkv",
          ],
          "A Show (2020)/Specials": ["A Show S00E01.mkv"],
          "B Show/Season 02": ["B Show S02E01.mkv"],
          "B Show/Season 02/extras": ["B Show S02E09.mkv"],
        };
        for (const [dir, names] of Object.entries(tree)) {
          await mkdir(join(root, dir), { recursive: true });
          for (const name of names) {
            await writeFile(join(root, dir, name), "dummy");
          }
        }
        const library = await insertLibrary(db, "Shows", root, "shows");
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);

        const rootJob = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "." },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim();
        expect(claimed?.id).toBe(rootJob.id);
        await registry.run(claimed ?? rootJob);

        const fanned = await listJobs(db, { state: "queued" });
        expect(fanned.map((job) => job.payload)).toEqual([
          { type: "scan", libraryId: library.id, path: "B Show" },
          { type: "scan", libraryId: library.id, path: "A Show (2020)" },
        ]);
        for (const job of fanned) {
          expect(job.concurrencyKey).toBe(libraryConcurrencyKey(library.id));
        }
      });
    }));
});
