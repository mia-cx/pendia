import { describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  events,
  items,
  libraries,
  probeCache,
  segmentTimelines,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { startJobWorker } from "../jobs/worker.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { createKeyframeFixture } from "../mediums/video-common/keyframe-fixtures.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
import {
  keyframesConcurrencyKey,
  runKeyframeIndexJob,
} from "./keyframe-index.ts";
import { scanDirectory, scanShowDirectory } from "./scan.ts";
import { insertLibraries } from "./testing.ts";

/** An ffprobe plus index read, like a watcher-reported probe carries. */
const probeWithIndex = async (path: string) => ({
  ...(await probeVideo(path)),
  keyframesSeconds: (await readKeyframeIndex(path)).keyframesSeconds,
});

async function withTempRoot<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "thalia-library-"));
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
  const [library] = await insertLibraries(db, { name, medium, rootPath });
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

async function waitForJobState(db: Database, id: string, state: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = (await listJobs(db)).find((row) => row.id === id);
    if (job?.state === state) return job;
    await Bun.sleep(10);
  }
  throw new Error(`Job ${id} did not reach state ${state}.`);
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
              reconcileMissing: true,
              runId: rootJob.id,
            },
            {
              type: "scan",
              libraryId: libraryA.id,
              path: "Alien (1979)",
              reconcileMissing: true,
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
            reconcileMissing: true,
            runId: rootJob.id,
          });
          expect(await queue.claim()).toBeUndefined();
          await queue.complete(first ?? rootJob);
          const second = await queue.claim();
          expect(second?.payload).toEqual({
            type: "scan",
            libraryId: libraryA.id,
            path: "Blade Runner (1982)",
            reconcileMissing: true,
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
            reconcileMissing: true,
            runId: rootJob.id,
          },
          {
            type: "scan",
            libraryId: library.id,
            path: "Alien (1979)",
            reconcileMissing: true,
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
          {
            type: "keyframe-index",
            libraryId: library.id,
            rootId: library.rootId,
            path: `${folder}/Alien.mkv`,
          },
        ]);
        expect(queued[0]?.concurrencyKey).toBe(`provider:${item.id}`);
        expect(await db.select().from(events)).toMatchObject([
          { kind: "library.changed" },
        ]);
      });
    }));

  test("an unchanged rescan of a matched Item enqueues no provider-fetch job", () =>
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
        const first = await queue.claim();
        if (!first) throw new Error("Scan job was not claimed.");
        await registry.run(first);
        await queue.complete(first);
        const [item] = await db.select().from(items);
        if (!item) throw new Error("Scanned item missing.");
        await db
          .update(items)
          .set({ metadataState: "matched" })
          .where(eq(items.id, item.id));
        // The first scan's provider-fetch job stays queued; drain it so the
        // rescan result is observable.
        const drained = await queue.claim(["provider-fetch"]);
        if (!drained) throw new Error("provider-fetch was not enqueued.");
        await queue.complete(drained);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: folder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim(["scan"]);
        if (!claimed) throw new Error("Rescan job was not claimed.");
        await registry.run(claimed);
        const [rescanned] = await db.select().from(items);
        expect(rescanned?.metadataState).toBe("matched");
        expect(
          (await listJobs(db, { state: "queued" })).map((job) => job.payload),
        ).toEqual([
          {
            type: "keyframe-index",
            libraryId: library.id,
            rootId: library.rootId,
            path: `${folder}/Alien.mkv`,
          },
        ]);
      });
    }));

  test("a pending rescan behind a running fetch enqueues one successor", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const oldFolder = "Alien (1979) {tmdb-550}";
        await mkdir(join(root, oldFolder));
        const oldPath = `${oldFolder}/Alien.mkv`;
        await createVideoFixture(join(root, oldPath));
        const library = await insertLibrary(db, "Movies", root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: oldFolder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const first = await queue.claim();
        if (!first) throw new Error("Scan job was not claimed.");
        await registry.run(first);
        await queue.complete(first);
        const [item] = await db.select().from(items);
        if (!item) throw new Error("Scanned item missing.");
        // Claim the fetch but never finish it: it stays running.
        const running = await queue.claim(["provider-fetch"]);
        if (!running) throw new Error("Fetch job was not claimed.");

        await queue.enqueue(
          {
            type: "scan",
            libraryId: library.id,
            path: oldFolder,
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: oldPath,
                providerIds: { tmdb: "551" },
              },
            ],
          },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const second = await queue.claim(["scan"]);
        if (!second) throw new Error("Rescan job was not claimed.");
        await registry.run(second);
        await queue.complete(second);
        // The changed provider id marks the Item pending, and the running
        // fetch cannot suppress the queued successor.
        expect(
          (await listJobs(db, { state: "queued" })).map((job) => job.payload),
        ).toEqual([
          { type: "provider-fetch", itemId: item.id },
          {
            type: "keyframe-index",
            libraryId: library.id,
            rootId: library.rootId,
            path: `${oldFolder}/Alien.mkv`,
          },
        ]);

        // A further pending scan coalesces onto the queued successor.
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: oldFolder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const third = await queue.claim(["scan"]);
        if (!third) throw new Error("Second rescan job was not claimed.");
        await registry.run(third);
        expect(
          (await listJobs(db, { state: "queued" })).map((job) => job.payload),
        ).toEqual([
          { type: "provider-fetch", itemId: item.id },
          {
            type: "keyframe-index",
            libraryId: library.id,
            rootId: library.rootId,
            path: `${oldFolder}/Alien.mkv`,
          },
        ]);
      });
    }));

  test("a pending rescan does not duplicate a queued provider-fetch job", () =>
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
        const first = await queue.claim();
        if (!first) throw new Error("Scan job was not claimed.");
        await registry.run(first);
        await queue.complete(first);
        const [item] = await db.select().from(items);
        if (!item) throw new Error("Scanned item missing.");
        // The Item stays pending while its provider-fetch remains queued.
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: folder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim(["scan"]);
        if (!claimed) throw new Error("Rescan job was not claimed.");
        await registry.run(claimed);
        const queued = await listJobs(db, { state: "queued" });
        expect(queued.map((job) => job.payload)).toEqual([
          { type: "provider-fetch", itemId: item.id },
          {
            type: "keyframe-index",
            libraryId: library.id,
            rootId: library.rootId,
            path: `${folder}/Alien.mkv`,
          },
        ]);
      });
    }));

  test("a changed provider id marks the Item pending and enqueues a refresh", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const folder = "Alien (1979) {tmdb-348}";
        const filePath = `${folder}/Alien.mkv`;
        await mkdir(join(root, folder));
        await createVideoFixture(join(root, filePath));
        const library = await insertLibrary(db, "Movies", root);
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: folder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const first = await queue.claim();
        if (!first) throw new Error("Scan job was not claimed.");
        await registry.run(first);
        await queue.complete(first);
        const [item] = await db.select().from(items);
        if (!item) throw new Error("Scanned item missing.");
        await db
          .update(items)
          .set({ metadataState: "matched" })
          .where(eq(items.id, item.id));
        const drained = await queue.claim(["provider-fetch"]);
        if (!drained) throw new Error("provider-fetch was not enqueued.");
        await queue.complete(drained);
        await queue.enqueue(
          {
            type: "scan",
            libraryId: library.id,
            path: folder,
            changes: [
              {
                kind: "add",
                rootId: library.rootId,
                path: filePath,
                providerIds: { tmdb: "999" },
              },
            ],
          },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim(["scan"]);
        if (!claimed) throw new Error("Rescan job was not claimed.");
        await registry.run(claimed);
        const [rescanned] = await db.select().from(items);
        expect(rescanned?.metadataState).toBe("pending");
        const queued = await listJobs(db, { state: "queued" });
        expect(queued.map((job) => job.payload)).toEqual([
          { type: "provider-fetch", itemId: item.id },
          {
            type: "keyframe-index",
            libraryId: library.id,
            rootId: library.rootId,
            path: filePath,
          },
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
          {
            type: "scan",
            libraryId: library.id,
            path: "B Show",
            reconcileMissing: true,
            runId: rootJob.id,
          },
          {
            type: "scan",
            libraryId: library.id,
            path: "A Show (2020)",
            reconcileMissing: true,
            runId: rootJob.id,
          },
        ]);
        for (const job of fanned) {
          expect(job.concurrencyKey).toBe(libraryConcurrencyKey(library.id));
        }
      });
    }));

  test("a library scan of a single-show root fans out one root directory scan", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (dir) => {
        const root = join(dir, "Breaking Bad (2008)");
        await mkdir(join(root, "Season 1"), { recursive: true });
        await createVideoFixture(
          join(root, "Season 1", "Breaking Bad - S01E01.mkv"),
        );
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
        await queue.complete(claimed ?? rootJob);

        const fanned = await listJobs(db, { state: "queued" });
        expect(fanned.map((job) => job.payload)).toEqual([
          {
            type: "scan",
            libraryId: library.id,
            path: ".",
            reconcileMissing: true,
            runId: rootJob.id,
          },
        ]);

        const directory = await queue.claim(["scan"]);
        if (!directory) throw new Error("Root directory scan was not queued.");
        await registry.run(directory);
        await queue.complete(directory);
        const [show] = await db.select().from(items);
        expect(show).toMatchObject({
          kind: "show",
          title: "Breaking Bad",
          canonicalFolder: ".",
          titleKey: "breaking bad (2008)",
        });
        expect(await queue.claim(["scan"])).toBeUndefined();
      });
    }));
});

describe.skipIf(!databaseUrl)("keyframe-index jobs", () => {
  const folder = "Movie (2020)";
  const path = `${folder}/Movie (2020).mp4`;

  async function scannedMovie(db: Database, root: string) {
    await mkdir(join(root, folder), { recursive: true });
    await createKeyframeFixture(join(root, path));
    const library = await insertLibrary(db, "Movies", root);
    await scanDirectory(db, library.id, folder);
    const [version] = await db.select().from(versions);
    if (!version) throw new Error("Fixture scan wrote no Version.");
    expect(version).toMatchObject({
      keyframesSeconds: null,
      lazyIndexPending: true,
    });
    return {
      library,
      version,
      job: {
        type: "keyframe-index" as const,
        libraryId: library.id,
        rootId: library.rootId,
        path,
      },
    };
  }

  test("stores the index on the cache entry and Version and derives the timeline", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { version, job } = await scannedMovie(db, root);
        await runKeyframeIndexJob(db, job);
        const [entry] = await db.select().from(probeCache);
        expect(entry?.result.keyframesSeconds).toEqual([0, 2, 4, 6, 8, 10]);
        const [after] = await db.select().from(versions);
        expect(after).toMatchObject({
          id: version.id,
          keyframesSeconds: [0, 2, 4, 6, 8, 10],
          lazyIndexPending: false,
          timelineAligned: true,
        });
        const [timeline] = await db.select().from(segmentTimelines);
        expect(timeline?.boundariesSeconds).toEqual([0, 4, 8, 12]);
        expect(after?.segmentTimelineId).toBe(timeline?.id);
      });
    }));

  test("a changed file completes as a no-op", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { version, job } = await scannedMovie(db, root);
        await appendFile(join(root, path), "mutated");
        await runKeyframeIndexJob(db, job);
        const [after] = await db.select().from(versions);
        expect(after).toMatchObject({
          id: version.id,
          keyframesSeconds: null,
          lazyIndexPending: true,
        });
        const [entry] = await db.select().from(probeCache);
        expect("keyframesSeconds" in (entry?.result ?? {})).toBe(false);
      });
    }));

  test("a file that changes during the read completes as a no-op", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { version, job } = await scannedMovie(db, root);
        await runKeyframeIndexJob(db, job, async (absolute) => {
          const index = await readKeyframeIndex(absolute);
          await appendFile(absolute, "mutated");
          return index;
        });
        const [after] = await db.select().from(versions);
        expect(after).toMatchObject({
          id: version.id,
          keyframesSeconds: null,
          lazyIndexPending: true,
        });
      });
    }));

  test("a missing file completes as a no-op", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { version, job } = await scannedMovie(db, root);
        await rm(join(root, path));
        await runKeyframeIndexJob(db, job);
        const [after] = await db.select().from(versions);
        expect(after).toMatchObject({
          id: version.id,
          keyframesSeconds: null,
          lazyIndexPending: true,
        });
      });
    }));

  test("a removed root or library completes as a no-op", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { library, job } = await scannedMovie(db, root);
        await db.delete(libraries).where(eq(libraries.id, library.id));
        await expect(runKeyframeIndexJob(db, job)).resolves.toBeUndefined();
      });
    }));

  test("an already-indexed file completes without reading again", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { job } = await scannedMovie(db, root);
        let reads = 0;
        const readIndex = async (absolute: string) => {
          reads++;
          return readKeyframeIndex(absolute);
        };
        await runKeyframeIndexJob(db, job, readIndex);
        await runKeyframeIndexJob(db, job, readIndex);
        expect(reads).toBe(1);
      });
    }));

  test("a slow read under a short lease completes through the worker", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { job } = await scannedMovie(db, root);
        const registry = createJobRegistry();
        registry.register("keyframe-index", (payload) =>
          runKeyframeIndexJob(db, payload, async (absolute) => {
            await Bun.sleep(1_000);
            return readKeyframeIndex(absolute);
          }),
        );
        const worker = await startJobWorker(db, registry, {
          pollIntervalMs: 50,
          queueOptions: { leaseMs: 300, renewMs: 100 },
          onError: () => {},
        });
        try {
          const queued = await createJobQueue(db).enqueue(job);
          const done = await waitForJobState(db, queued.id, "completed");
          expect(done.error).toBeNull();
          const [after] = await db.select().from(versions);
          expect(after?.lazyIndexPending).toBe(false);
        } finally {
          await worker.stop();
        }
      });
    }));

  test("a library scan claims while that library's index job runs", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { library, job } = await scannedMovie(db, root);
        const queue = createJobQueue(db);
        await queue.enqueue(job, {
          concurrencyKey: keyframesConcurrencyKey(library.id),
        });
        const running = await queue.claim(["keyframe-index"]);
        expect(running?.payload).toEqual(job);
        const scan = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: folder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimed = await queue.claim(["scan"]);
        expect(claimed?.id).toBe(scan.id);
      });
    }));
});

describe.skipIf(!databaseUrl)("scan-queued keyframe-index jobs", () => {
  const folder = "Movie (2020)";

  test("a directory scan queues one job per unindexed single-File Version", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createKeyframeFixture(join(root, folder, "Movie (2020).mp4"));
        await createKeyframeFixture(
          join(root, folder, "Movie (2020) 1080p.mp4"),
          { gop: 75 },
        );
        const library = await insertLibrary(db, "Movies", root);
        await scanDirectory(db, library.id, folder);
        const queued = await listJobs(db, { state: "queued" });
        expect(
          queued
            .map((job) => job.payload)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ).toEqual(
          [
            {
              type: "keyframe-index" as const,
              libraryId: library.id,
              rootId: library.rootId,
              path: `${folder}/Movie (2020) 1080p.mp4`,
            },
            {
              type: "keyframe-index" as const,
              libraryId: library.id,
              rootId: library.rootId,
              path: `${folder}/Movie (2020).mp4`,
            },
          ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        );
        for (const job of queued) {
          expect(job.type).toBe("keyframe-index");
          expect(job.priority).toBe(-5);
          expect(job.concurrencyKey).toBe(keyframesConcurrencyKey(library.id));
        }
      });
    }));

  test("a rescan queues no duplicate and the stored index survives it", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        const file = join(root, folder, "Movie (2020).mp4");
        await createKeyframeFixture(file);
        const library = await insertLibrary(db, "Movies", root);
        await scanDirectory(db, library.id, folder);
        expect(
          (await listJobs(db)).filter((job) => job.type === "keyframe-index"),
        ).toHaveLength(1);
        // The index landing makes a later rescan leave no pending work.
        await runKeyframeIndexJob(db, {
          type: "keyframe-index",
          libraryId: library.id,
          rootId: library.rootId,
          path: `${folder}/Movie (2020).mp4`,
        });
        await createJobQueue(db).enqueue(
          { type: "scan", libraryId: library.id, path: "." },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        await scanDirectory(db, library.id, folder);
        expect(
          (await listJobs(db)).filter((job) => job.type === "keyframe-index"),
        ).toHaveLength(1);
        const [version] = await db.select().from(versions);
        expect(version?.keyframesSeconds).toEqual([0, 2, 4, 6, 8, 10]);
        expect(version?.lazyIndexPending).toBe(false);
      });
    }));

  test("an index-carrying probe queues no job", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        await mkdir(join(root, folder), { recursive: true });
        await createKeyframeFixture(join(root, folder, "Movie (2020).mp4"));
        const library = await insertLibrary(db, "Movies", root);
        await scanDirectory(db, library.id, folder, {
          probe: probeWithIndex,
        });
        expect(
          (await listJobs(db)).filter((job) => job.type === "keyframe-index"),
        ).toHaveLength(0);
        const [version] = await db.select().from(versions);
        expect(version?.keyframesSeconds).toEqual([0, 2, 4, 6, 8, 10]);
      });
    }));

  test("a split Episode Version queues no job", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const showDir = join(root, "Show", "Season 01");
        await mkdir(showDir, { recursive: true });
        await createVideoFixture(join(showDir, "Show S01E01 - part1.mkv"));
        await createVideoFixture(join(showDir, "Show S01E01 - part2.mkv"));
        const library = await insertLibrary(db, "Shows", root, "shows");
        await scanShowDirectory(db, library.id, "Show");
        expect(
          (await listJobs(db)).filter((job) => job.type === "keyframe-index"),
        ).toHaveLength(0);
        const [version] = await db.select().from(versions);
        expect(version).toMatchObject({
          keyframesSeconds: null,
          lazyIndexPending: false,
        });
      });
    }));

  test("an existing split Version rescanned through one File queues no job", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const showDir = join(root, "Show", "Season 01");
        await mkdir(showDir, { recursive: true });
        await createVideoFixture(join(showDir, "Show S01E01 - part1.mkv"));
        await createVideoFixture(join(showDir, "Show S01E01 - part2.mkv"));
        const library = await insertLibrary(db, "Shows", root, "shows");
        await scanShowDirectory(db, library.id, "Show");
        const renamed = "Show/Season 01/Show S01E01 1080p.mkv";
        await rename(
          join(showDir, "Show S01E01 - part2.mkv"),
          join(root, renamed),
        );
        await scanShowDirectory(db, library.id, "Show", {
          reconcileMissing: true,
          changes: [
            {
              kind: "move",
              rootId: library.rootId,
              path: renamed,
              previousPath: "Show/Season 01/Show S01E01 - part2.mkv",
              providerIds: {},
            },
          ],
        });
        expect(
          (await listJobs(db)).filter((job) => job.type === "keyframe-index"),
        ).toHaveLength(0);
      });
    }));
});
