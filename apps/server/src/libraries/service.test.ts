import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { files, items, jobs, progress } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
import {
  createLibrary,
  deleteLibrary,
  getLibrary,
  libraryScanStatus,
  listLibraries,
  RootError,
  scanLibrary,
  updateLibrary,
} from "./service.ts";

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  return { admin, viewer };
}

async function withTempRoot<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pendia-library-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function expectAuthError(
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

async function expectRootError(
  promise: Promise<unknown>,
  root: number | undefined,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(RootError);
  expect(error).toMatchObject({ root });
}

const bladeRunner = "Blade Runner (1982)/Blade Runner (1982).mkv";
const alien = "Alien (1979)/Alien (1979).mkv";

/** Two roots: Blade Runner in both, Alien only in the second. */
async function withTwoRoots(
  run: (roots: { hq: string; transcoded: string }) => Promise<void>,
) {
  await withVideoFixture(async (dir) => {
    const hq = join(dir, "hq");
    const transcoded = join(dir, "transcoded");
    for (const [root, file] of [
      [hq, bladeRunner],
      [transcoded, bladeRunner],
      [transcoded, alien],
    ] as const) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await createVideoFixture(join(root, file), {
        width: root === hq ? 1920 : 1280,
        height: root === hq ? 1080 : 720,
      });
    }
    await run({ hq, transcoded });
  });
}

/** Runs every queued scan, the way a worker would. */
async function drainScans(db: Database) {
  const registry = createJobRegistry();
  registerLibraryJobs(db, registry);
  const queue = createJobQueue(db);
  for (;;) {
    const job = await queue.claim(["scan"]);
    if (job === undefined) return;
    await registry.run(job);
    await queue.complete(job);
  }
}

async function itemFiles(db: Database, title: string) {
  return db
    .select({ itemId: items.id, rootId: files.rootId, path: files.path })
    .from(files)
    .innerJoin(items, eq(items.id, files.itemId))
    .where(eq(items.title, title))
    .orderBy(asc(files.rootId));
}

describe.skipIf(!databaseUrl)("library service", () => {
  test("creates, renames, lists, gets and deletes a library", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await withTempRoot(async (root) => {
        const created = await createLibrary(db, admin.id, {
          name: "  Movies  ",
          medium: "movies",
          roots: [`${root}/hq/../movies`, `${root}/transcoded`],
        });
        expect(created).toMatchObject({
          name: "Movies",
          medium: "movies",
          roots: [{ path: `${root}/movies` }, { path: `${root}/transcoded` }],
        });
        expect(Object.keys(created).sort()).toEqual([
          "id",
          "medium",
          "name",
          "roots",
        ]);
        const second = await createLibrary(db, admin.id, {
          name: "Shows",
          medium: "shows",
          roots: [`${root}/shows`],
        });
        expect(await listLibraries(db, admin.id)).toEqual([created, second]);
        expect(await getLibrary(db, admin.id, created.id)).toEqual(created);
        const renamed = await updateLibrary(db, admin.id, created.id, {
          name: "  Film Collection ",
        });
        expect(renamed).toEqual({ ...created, name: "Film Collection" });
        expect(await deleteLibrary(db, admin.id, created.id)).toEqual({
          ok: true,
        });
        expect(await listLibraries(db, admin.id)).toEqual([second]);
      });
    }));

  test("delete leaves files on disk untouched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await withTempRoot(async (root) => {
        const fixture = join(root, "keep.mkv");
        await writeFile(fixture, "movie bytes");
        const library = await createLibrary(db, admin.id, {
          name: "Movies",
          medium: "movies",
          roots: [root],
        });
        await deleteLibrary(db, admin.id, library.id);
        expect(await readFile(fixture, "utf8")).toBe("movie bytes");
      });
    }));

  test("unknown ids fail with NOT_FOUND", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const missing = Bun.randomUUIDv7();
      await expectAuthError(getLibrary(db, admin.id, missing), "NOT_FOUND");
      await expectAuthError(
        updateLibrary(db, admin.id, missing, { name: "x" }),
        "NOT_FOUND",
      );
      await expectAuthError(deleteLibrary(db, admin.id, missing), "NOT_FOUND");
      await expectAuthError(scanLibrary(db, admin.id, missing), "NOT_FOUND");
    }));

  test("invalid names fail with INVALID_INPUT and invalid roots name the root", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      for (const name of ["", "   ", "x".repeat(129), "bad\0name"]) {
        await expectAuthError(
          createLibrary(db, admin.id, {
            name,
            medium: "movies",
            roots: ["/srv/movies"],
          }),
          "INVALID_INPUT",
        );
      }
      for (const path of ["relative/movies", "/srv/mov\0ies", ""]) {
        await expectRootError(
          createLibrary(db, admin.id, {
            name: "Movies",
            medium: "movies",
            roots: ["/srv/movies", path],
          }),
          1,
        );
      }
      await expectRootError(
        createLibrary(db, admin.id, {
          name: "Movies",
          medium: "movies",
          roots: [],
        }),
        undefined,
      );
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      await expectAuthError(
        updateLibrary(db, admin.id, library.id, { name: "" }),
        "INVALID_INPUT",
      );
      await expectAuthError(
        updateLibrary(db, admin.id, library.id, { name: "bad\0name" }),
        "INVALID_INPUT",
      );
      expect((await getLibrary(db, admin.id, library.id)).name).toBe("Movies");
    }));

  test("non-admin actors cannot perform any operation", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      await expectAuthError(listLibraries(db, viewer.id), "FORBIDDEN");
      await expectAuthError(getLibrary(db, viewer.id, library.id), "FORBIDDEN");
      await expectAuthError(
        createLibrary(db, viewer.id, {
          name: "x",
          medium: "movies",
          roots: ["/x"],
        }),
        "FORBIDDEN",
      );
      await expectAuthError(
        updateLibrary(db, viewer.id, library.id, { name: "x" }),
        "FORBIDDEN",
      );
      await expectAuthError(
        deleteLibrary(db, viewer.id, library.id),
        "FORBIDDEN",
      );
      await expectAuthError(
        scanLibrary(db, viewer.id, library.id),
        "FORBIDDEN",
      );
    }));

  test("scanLibrary enqueues both medium roots with the library key", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const moviesLibrary = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      const showsLibrary = await createLibrary(db, admin.id, {
        name: "Shows",
        medium: "shows",
        roots: ["/srv/shows"],
      });
      for (const library of [moviesLibrary, showsLibrary]) {
        await scanLibrary(db, admin.id, library.id);
      }
      const jobs = await listJobs(db);
      expect(jobs).toHaveLength(2);
      expect(
        jobs.map((job) => ({
          payload: job.payload,
          concurrencyKey: job.concurrencyKey,
        })),
      ).toEqual([
        {
          payload: { type: "scan", libraryId: showsLibrary.id, path: "." },
          concurrencyKey: libraryConcurrencyKey(showsLibrary.id),
        },
        {
          payload: { type: "scan", libraryId: moviesLibrary.id, path: "." },
          concurrencyKey: libraryConcurrencyKey(moviesLibrary.id),
        },
      ]);
    }));

  test("scanLibrary enqueues a root scan job with the library key", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      const { jobId } = await scanLibrary(db, admin.id, library.id);
      const [job] = await listJobs(db);
      expect(job).toMatchObject({
        id: jobId,
        type: "scan",
        state: "queued",
        concurrencyKey: libraryConcurrencyKey(library.id),
        payload: { type: "scan", libraryId: library.id, path: "." },
      });
    }));

  test("libraryScanStatus counts scan jobs and reports the newest", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      expect(await libraryScanStatus(db, admin.id, library.id)).toEqual({
        libraryId: library.id,
        counts: { queued: 0, running: 0, completed: 0, failed: 0 },
        latest: null,
        runId: null,
      });
      const { jobId } = await scanLibrary(db, admin.id, library.id);
      const status = await libraryScanStatus(db, admin.id, library.id);
      expect(status.counts).toEqual({
        queued: 1,
        running: 0,
        completed: 0,
        failed: 0,
      });
      expect(status.latest).toMatchObject({
        id: jobId,
        state: "queued",
        error: null,
      });
      expect(status.runId).toBe(jobId);
      await db
        .update(jobs)
        .set({ state: "completed" })
        .where(eq(jobs.id, jobId));
      const second = await scanLibrary(db, admin.id, library.id);
      const rerun = await libraryScanStatus(db, admin.id, library.id);
      expect(rerun.counts).toEqual({
        queued: 1,
        running: 0,
        completed: 0,
        failed: 0,
      });
      expect(rerun.runId).toBe(second.jobId);
      expect(rerun.latest?.id).toBe(second.jobId);
      const other = await createLibrary(db, admin.id, {
        name: "Other",
        medium: "movies",
        roots: ["/srv/other"],
      });
      await scanLibrary(db, admin.id, other.id);
      expect(
        (await libraryScanStatus(db, admin.id, library.id)).counts.queued,
      ).toBe(1);
      expect(
        (await libraryScanStatus(db, admin.id, other.id)).counts.queued,
      ).toBe(1);
    }));

  test("libraryScanStatus scopes counts to one run when scans overlap", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      const first = await scanLibrary(db, admin.id, library.id);
      const second = await scanLibrary(db, admin.id, library.id);
      const [child] = await db
        .insert(jobs)
        .values({
          type: "scan",
          payload: {
            type: "scan",
            libraryId: library.id,
            path: "Alien (1979)",
            runId: first.jobId,
          },
          state: "failed",
          maxAttempts: 3,
        })
        .returning({ id: jobs.id });
      if (!child) throw new Error("Job insert returned no row.");

      const forSecond = await libraryScanStatus(
        db,
        admin.id,
        library.id,
        second.jobId,
      );
      expect(forSecond.runId).toBe(second.jobId);
      expect(forSecond.counts.failed).toBe(0);
      expect(forSecond.latest?.id).toBe(second.jobId);

      const forFirst = await libraryScanStatus(
        db,
        admin.id,
        library.id,
        first.jobId,
      );
      expect(forFirst.runId).toBe(first.jobId);
      expect(forFirst.counts.failed).toBe(1);
      expect(forFirst.latest?.id).toBe(child.id);

      const resolved = await libraryScanStatus(db, admin.id, library.id);
      expect(resolved.runId).toBe(second.jobId);
      expect(resolved.counts.failed).toBe(0);

      await expectAuthError(
        libraryScanStatus(db, admin.id, library.id, Bun.randomUUIDv7()),
        "NOT_FOUND",
      );
    }));

  test("libraryScanStatus rejects a directory job id as a run id", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      const { jobId } = await scanLibrary(db, admin.id, library.id);
      const [child] = await db
        .insert(jobs)
        .values({
          type: "scan",
          payload: {
            type: "scan",
            libraryId: library.id,
            path: "Alien (1979)",
            runId: jobId,
          },
          state: "completed",
          maxAttempts: 3,
        })
        .returning({ id: jobs.id });
      if (!child) throw new Error("Job insert returned no row.");

      await expectAuthError(
        libraryScanStatus(db, admin.id, library.id, child.id),
        "NOT_FOUND",
      );
      const status = await libraryScanStatus(db, admin.id, library.id, jobId);
      expect(status.runId).toBe(jobId);
      expect(status.counts).toEqual({
        queued: 1,
        running: 0,
        completed: 1,
        failed: 0,
      });
    }));

  test("libraryScanStatus rejects unknown ids and non-admin actors", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/movies"],
      });
      await expectAuthError(
        libraryScanStatus(db, admin.id, Bun.randomUUIDv7()),
        "NOT_FOUND",
      );
      await expectAuthError(
        libraryScanStatus(db, viewer.id, library.id),
        "FORBIDDEN",
      );
    }));

  test("refuses roots that overlap in one library or across libraries", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const movies = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: ["/srv/media/movies"],
      });
      const create = (roots: string[]) =>
        createLibrary(db, admin.id, { name: "Shows", medium: "shows", roots });
      await expectRootError(create(["/srv/media/movies/shows"]), 0);
      await expectRootError(create(["/srv/shows", "/srv/media"]), 1);
      await expectRootError(create(["/srv/shows", "/srv/shows/"]), 1);
      await expectRootError(create(["/srv/shows", "/srv/shows/anime"]), 1);
      await expect(create(["/srv/media/movies-4k"])).resolves.toMatchObject({
        roots: [{ path: "/srv/media/movies-4k" }],
      });
      const [first] = movies.roots;
      if (first === undefined) throw new Error("Library has no root.");
      const update = (roots: { id?: string; path: string }[]) =>
        updateLibrary(db, admin.id, movies.id, { roots });
      await expectRootError(
        update([first, { path: "/srv/media/movies/hq" }]),
        1,
      );
      await expectRootError(update([]), undefined);
      await expectRootError(
        update([{ id: Bun.randomUUIDv7(), path: "/srv/other" }]),
        0,
      );
      expect((await getLibrary(db, admin.id, movies.id)).roots).toEqual([
        first,
      ]);
    }));

  test("removing a root drops its Files and the Items only it held", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await withTwoRoots(async ({ hq, transcoded }) => {
        const library = await createLibrary(db, admin.id, {
          name: "Movies",
          medium: "movies",
          roots: [hq, transcoded],
        });
        const [hqRoot, transcodedRoot] = library.roots;
        if (!hqRoot || !transcodedRoot) throw new Error("Roots missing.");
        await scanLibrary(db, admin.id, library.id);
        await drainScans(db);
        const before = await itemFiles(db, "Blade Runner");
        expect(before.map((file) => file.rootId).sort()).toEqual(
          [hqRoot.id, transcodedRoot.id].sort(),
        );
        expect(new Set(before.map((file) => file.itemId)).size).toBe(1);
        const [alienFile] = await itemFiles(db, "Alien");
        if (!alienFile) throw new Error("Alien was not scanned.");
        await db.insert(progress).values({
          userId: admin.id,
          itemId: alienFile.itemId,
          format: "video",
          positionSeconds: 12,
        });

        const updated = await updateLibrary(db, admin.id, library.id, {
          roots: [hqRoot],
        });
        expect(updated.roots).toEqual([hqRoot]);
        expect(await itemFiles(db, "Blade Runner")).toEqual(
          before.filter((file) => file.rootId === hqRoot.id),
        );
        expect(await itemFiles(db, "Alien")).toEqual([]);
        expect(
          await db.select().from(items).where(eq(items.id, alienFile.itemId)),
        ).toEqual([]);
        expect(await db.select().from(progress)).toEqual([]);
        // Only adding or repointing a root rescans.
        expect(await listJobs(db, { state: "queued", type: "scan" })).toEqual(
          [],
        );
      });
    }));

  test("repointing a root keeps Items and progress, and adding one scans it", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await withTwoRoots(async ({ hq, transcoded }) => {
        const library = await createLibrary(db, admin.id, {
          name: "Movies",
          medium: "movies",
          roots: [hq],
        });
        const [hqRoot] = library.roots;
        if (!hqRoot) throw new Error("Root missing.");
        await scanLibrary(db, admin.id, library.id);
        await drainScans(db);
        const [before] = await itemFiles(db, "Blade Runner");
        if (!before) throw new Error("Blade Runner was not scanned.");
        await db.insert(progress).values({
          userId: admin.id,
          itemId: before.itemId,
          format: "video",
          positionSeconds: 42,
        });

        const moved = `${hq}-moved`;
        await rename(hq, moved);
        await updateLibrary(db, admin.id, library.id, {
          roots: [{ id: hqRoot.id, path: moved }],
        });
        const [rescan] = await listJobs(db, { state: "queued", type: "scan" });
        expect(rescan?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: ".",
        });
        await drainScans(db);
        expect(await itemFiles(db, "Blade Runner")).toEqual([before]);
        expect(
          (await db.select().from(progress)).map((row) => row.itemId),
        ).toEqual([before.itemId]);

        const added = await updateLibrary(db, admin.id, library.id, {
          name: "Films",
          roots: [{ id: hqRoot.id, path: moved }, { path: transcoded }],
        });
        expect(added).toMatchObject({
          name: "Films",
          roots: [{ id: hqRoot.id, path: moved }, { path: transcoded }],
        });
        await drainScans(db);
        const after = await itemFiles(db, "Blade Runner");
        expect(after).toHaveLength(2);
        expect(after.every((file) => file.itemId === before.itemId)).toBe(true);
        expect(await itemFiles(db, "Alien")).toHaveLength(1);
      });
    }));
});
