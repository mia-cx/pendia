import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { events, items, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
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
            },
            { type: "scan", libraryId: libraryA.id, path: "Alien (1979)" },
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
          });
          expect(await queue.claim()).toBeUndefined();
          await queue.complete(first ?? rootJob);
          const second = await queue.claim();
          expect(second?.payload).toEqual({
            type: "scan",
            libraryId: libraryA.id,
            path: "Blade Runner (1982)",
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
        await queue.enqueue(
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
          },
          { type: "scan", libraryId: library.id, path: "Alien (1979)" },
        ]);
        expect(
          children.every(
            (job) => job.concurrencyKey === libraryConcurrencyKey(library.id),
          ),
        ).toBe(true);
      });
    }));

  test("a directory scan enqueues one provider-fetch job for its Item", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const folder = "Alien (1979) {tmdb-348}";
        await mkdir(join(root, folder));
        await createVideoFixture(join(root, folder, "Alien.mkv"));
        const library = await insertLibrary(db, "Movies", root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: folder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim();
        if (!claimed) throw new Error("Scan job was not claimed.");
        await registry.run(claimed);
        const [item] = await db.select().from(items);
        if (!item) throw new Error("Scanned item missing.");
        const queued = await listJobs(db, { state: "queued" });
        expect(queued.map((job) => job.payload)).toEqual([
          { type: "provider-fetch", itemId: item.id },
        ]);
        expect(queued[0]?.concurrencyKey).toBe(`provider:${item.id}`);
        expect(await db.select().from(events)).toMatchObject([
          { kind: "library.changed" },
        ]);
      });
    }));

  test("provider-fetch jobs on one item claim one at a time", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const itemId = Bun.randomUUIDv7();
      const key = `provider:${itemId}`;
      const first = await queue.enqueue(
        { type: "provider-fetch", itemId },
        { concurrencyKey: key },
      );
      const second = await queue.enqueue(
        { type: "provider-fetch", itemId },
        { concurrencyKey: key },
      );
      const claimed = await queue.claim(["provider-fetch"]);
      expect(claimed?.id).toBe(first.id);
      expect(await queue.claim(["provider-fetch"])).toBeUndefined();
      await queue.complete(claimed ?? first);
      const next = await queue.claim(["provider-fetch"]);
      expect(next?.id).toBe(second.id);
    }));

  test("an empty directory scan enqueues no provider-fetch job", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        await mkdir(join(root, "empty"));
        const library = await insertLibrary(db, "Movies", root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "empty" },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim();
        if (!claimed) throw new Error("Scan job was not claimed.");
        await registry.run(claimed);
        expect(await listJobs(db, { state: "queued" })).toHaveLength(0);
        expect(await db.select().from(items)).toHaveLength(0);
        expect(await db.select().from(events)).toMatchObject([
          { kind: "library.changed" },
        ]);
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

  test("missing and non-movie libraries reject", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const shows = await insertLibrary(db, "Shows", root, "shows");
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        for (const [libraryId, code] of [
          [Bun.randomUUIDv7(), "NOT_FOUND"],
          [shows.id, "INVALID_INPUT"],
        ] as const) {
          const job = await queue.enqueue(
            { type: "scan", libraryId, path: "." },
            { concurrencyKey: libraryConcurrencyKey(libraryId) },
          );
          const claimed = await queue.claim();
          if (!claimed) throw new Error("Job was not claimed.");
          await expectHandlerError(registry.run(claimed), code);
          await queue.complete(claimed);
          expect(job.id).toBe(claimed.id);
        }
      });
    }));
});
