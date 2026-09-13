import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { jobs } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { listJobs } from "../jobs/queue.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import {
  createLibrary,
  deleteLibrary,
  getLibrary,
  libraryScanStatus,
  listLibraries,
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

describe.skipIf(!databaseUrl)("library service", () => {
  test("creates, renames, lists, gets and deletes a library", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      await withTempRoot(async (root) => {
        const created = await createLibrary(db, admin.id, {
          name: "  Movies  ",
          medium: "movies",
          rootPath: `${root}/movies/..`,
        });
        expect(created).toMatchObject({
          name: "Movies",
          medium: "movies",
          rootPath: root,
        });
        expect(Object.keys(created).sort()).toEqual([
          "id",
          "medium",
          "name",
          "rootPath",
        ]);
        const second = await createLibrary(db, admin.id, {
          name: "Shows",
          medium: "shows",
          rootPath: root,
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
          rootPath: root,
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

  test("invalid names and roots fail with INVALID_INPUT", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      for (const name of ["", "   ", "x".repeat(129), "bad\0name"]) {
        await expectAuthError(
          createLibrary(db, admin.id, {
            name,
            medium: "movies",
            rootPath: "/srv/movies",
          }),
          "INVALID_INPUT",
        );
      }
      for (const rootPath of ["relative/movies", "/srv/mov\0ies", ""]) {
        await expectAuthError(
          createLibrary(db, admin.id, {
            name: "Movies",
            medium: "movies",
            rootPath,
          }),
          "INVALID_INPUT",
        );
      }
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        rootPath: "/srv/movies",
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
        rootPath: "/srv/movies",
      });
      await expectAuthError(listLibraries(db, viewer.id), "FORBIDDEN");
      await expectAuthError(getLibrary(db, viewer.id, library.id), "FORBIDDEN");
      await expectAuthError(
        createLibrary(db, viewer.id, {
          name: "x",
          medium: "movies",
          rootPath: "/x",
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
        rootPath: "/srv/movies",
      });
      const showsLibrary = await createLibrary(db, admin.id, {
        name: "Shows",
        medium: "shows",
        rootPath: "/srv/shows",
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
        rootPath: "/srv/movies",
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
        rootPath: "/srv/movies",
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
        rootPath: "/srv/other",
      });
      await scanLibrary(db, admin.id, other.id);
      expect(
        (await libraryScanStatus(db, admin.id, library.id)).counts.queued,
      ).toBe(1);
      expect(
        (await libraryScanStatus(db, admin.id, other.id)).counts.queued,
      ).toBe(1);
    }));

  test("libraryScanStatus rejects unknown ids and non-admin actors", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { admin, viewer } = await seed(db);
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        rootPath: "/srv/movies",
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
});
