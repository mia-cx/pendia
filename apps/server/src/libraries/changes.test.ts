import { describe, expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { asc } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  items,
  libraries,
  progress,
  providerIds,
  type ScanChange,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { setItemProviderIds } from "./changes.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
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

async function runScanJob(
  db: Database,
  libraryId: string,
  path: string,
  changes?: ScanChange[],
) {
  const queue = createJobQueue(db);
  const registry = createJobRegistry();
  registerLibraryJobs(db, registry);
  await queue.enqueue(
    { type: "scan", libraryId, path, changes },
    { concurrencyKey: libraryConcurrencyKey(libraryId) },
  );
  const claimed = await queue.claim();
  if (!claimed) throw new Error("Scan job was not claimed.");
  try {
    await registry.run(claimed);
  } catch (error) {
    await queue.fail(claimed, error);
    throw error;
  }
  await queue.complete(claimed);
}

async function expectAuthError(
  promise: Promise<unknown>,
  code: AuthError["code"],
) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    return;
  }
  throw new Error(`Expected the scan job to reject with ${code}.`);
}

describe.skipIf(!databaseUrl)("scan changes", () => {
  test("a move change preserves Item, Version, File and Progress identity", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(dir, "Alien.1080p.mkv"));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        const [file] = await db.select().from(files);
        const [version] = await db.select().from(versions);
        if (!file || !version) {
          throw new Error("Initial scan produced no File.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId,
          versionId: version.id,
          format: "video",
          positionSeconds: 120,
          playCount: 3,
          playedAt: new Date("2026-01-02T00:00:00Z"),
        });
        const progressBefore = await db.select().from(progress);

        const movedPath = `${folder}/Alien.Renamed.1080p.mkv`;
        await rename(
          join(dir, "Alien.1080p.mkv"),
          join(dir, "Alien.Renamed.1080p.mkv"),
        );
        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: movedPath,
            previousPath: file1080,
            providerIds: { tmdb: "348", imdb: "tt0078748" },
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows).toHaveLength(1);
        expect(itemRows[0]).toMatchObject({
          id: itemId,
          canonicalFolder: folder,
        });
        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(1);
        expect(fileRows[0]).toMatchObject({
          id: file.id,
          versionId: version.id,
          itemId,
          path: movedPath,
        });
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).toEqual([version.id]);
        expect(await db.select().from(progress)).toEqual(progressBefore);
        const idRows = await db
          .select()
          .from(providerIds)
          .orderBy(asc(providerIds.provider));
        expect(
          idRows.map((row) => [row.provider, row.value, row.itemId]),
        ).toEqual([
          ["imdb", "tt0078748", itemId],
          ["tmdb", "348", itemId],
        ]);
      });
    }));

  test("a file-delete change removes the last Version and its Item", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(dir, "Alien.1080p.mkv"));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        const [version] = await db.select().from(versions);
        if (!version) throw new Error("Initial scan produced no Version.");
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId,
          versionId: version.id,
          format: "video",
          positionSeconds: 42,
        });
        await setItemProviderIds(db, itemId, {
          tmdb: "348",
          imdb: "tt0078748",
        });

        await rm(join(dir, "Alien.1080p.mkv"));
        await runScanJob(db, library.id, folder, [
          {
            kind: "delete",
            path: file1080,
            target: "file",
            providerIds: {},
          },
        ]);

        expect(await db.select().from(files)).toEqual([]);
        expect(await db.select().from(streams)).toEqual([]);
        expect(await db.select().from(versions)).toEqual([]);
        expect(await db.select().from(items)).toEqual([]);
        expect(await db.select().from(providerIds)).toEqual([]);
        expect(await db.select().from(progress)).toEqual([]);
      });
    }));

  test("a file-delete change keeps an Item with remaining Versions", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        await createVideoFixture(join(root, file2160));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        const fileRows = await db.select().from(files).orderBy(asc(files.path));
        const [deleted, kept] = fileRows;
        if (!deleted || !kept) {
          throw new Error("Initial scan produced fewer than two Files.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId,
          versionId: deleted.versionId,
          format: "video",
          positionSeconds: 77,
          playCount: 2,
        });

        await rm(join(root, deleted.path));
        await runScanJob(db, library.id, folder, [
          {
            kind: "delete",
            path: deleted.path,
            target: "file",
            providerIds: {},
          },
        ]);

        expect(await db.select().from(items)).toHaveLength(1);
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).toEqual([kept.versionId]);
        const remainingFiles = await db.select().from(files);
        expect(remainingFiles.map((row) => row.id)).toEqual([kept.id]);
        const progressRows = await db.select().from(progress);
        expect(progressRows).toHaveLength(1);
        expect(progressRows[0]).toMatchObject({
          userId: admin.id,
          itemId,
          versionId: null,
          positionSeconds: 77,
          playCount: 2,
        });
      });
    }));

  test("an upgrade batch keeps the Item and Progress through add then delete", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        const [oldFile] = await db.select().from(files);
        const [oldVersion] = await db.select().from(versions);
        if (!oldFile || !oldVersion) {
          throw new Error("Initial scan produced no File.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId,
          versionId: oldVersion.id,
          format: "video",
          positionSeconds: 55,
          playCount: 1,
        });

        const upgraded = `${folder}/Alien.2160p.mkv`;
        await rm(join(root, file1080));
        await createVideoFixture(join(root, upgraded));
        await runScanJob(db, library.id, folder, [
          {
            kind: "add",
            path: upgraded,
            providerIds: { tmdb: "348", imdb: "tt0078748" },
          },
          {
            kind: "delete",
            path: file1080,
            target: "file",
            providerIds: { tmdb: "348", imdb: "tt0078748" },
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.id)).toEqual([itemId]);
        const versionRows = await db.select().from(versions);
        expect(versionRows).toHaveLength(1);
        expect(versionRows[0]?.id).not.toBe(oldVersion.id);
        expect(versionRows[0]).toMatchObject({ itemId });
        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(1);
        expect(fileRows[0]?.id).not.toBe(oldFile.id);
        expect(fileRows[0]).toMatchObject({ itemId, path: upgraded });
        const progressRows = await db.select().from(progress);
        expect(progressRows).toHaveLength(1);
        expect(progressRows[0]).toMatchObject({
          itemId,
          versionId: null,
          positionSeconds: 55,
          playCount: 1,
        });
        const idRows = await db
          .select()
          .from(providerIds)
          .orderBy(asc(providerIds.provider));
        expect(idRows.map((row) => [row.provider, row.value])).toEqual([
          ["imdb", "tt0078748"],
          ["tmdb", "348"],
        ]);
      });
    }));

  test("an item-delete change resolves by provider ids over a stale folder", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(dir, "Alien.1080p.mkv"));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        await setItemProviderIds(db, itemId, {
          tmdb: "348",
          imdb: "tt0078748",
        });

        await rm(dir, { recursive: true });
        const staleFolder = "Alien Remastered (2025)";
        await runScanJob(db, library.id, staleFolder, [
          {
            kind: "delete",
            path: staleFolder,
            target: "item",
            providerIds: { tmdb: "348" },
          },
        ]);

        expect(await db.select().from(items)).toEqual([]);
        expect(await db.select().from(versions)).toEqual([]);
        expect(await db.select().from(files)).toEqual([]);
        expect(await db.select().from(providerIds)).toEqual([]);
      });
    }));

  test("a plain rescan reconciles a file missing on disk", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        await createVideoFixture(join(root, file2160));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);
        const fileRows = await db.select().from(files).orderBy(asc(files.path));
        const [deleted, kept] = fileRows;
        if (!deleted || !kept) {
          throw new Error("Initial scan produced fewer than two Files.");
        }

        await rm(join(root, deleted.path));
        await runScanJob(db, library.id, folder);

        expect(await db.select().from(items)).toHaveLength(1);
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).toEqual([kept.versionId]);
        const remainingFiles = await db.select().from(files);
        expect(remainingFiles.map((row) => row.id)).toEqual([kept.id]);
      });
    }));

  test("a plain rescan removes an Item whose only file vanished", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);
        expect(await db.select().from(streams)).not.toEqual([]);

        await rm(join(root, file1080));
        await runScanJob(db, library.id, folder);

        expect(await db.select().from(items)).toEqual([]);
        expect(await db.select().from(versions)).toEqual([]);
        expect(await db.select().from(files)).toEqual([]);
        expect(await db.select().from(streams)).toEqual([]);
      });
    }));

  test("provider ids conflicting with an occupied folder reject the scan", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const otherFolder = "Blade Runner (1982) {tmdb-78}";
        const otherFile = `${otherFolder}/Blade.Runner.1080p.mkv`;
        await mkdir(join(root, folder), { recursive: true });
        await mkdir(join(root, otherFolder), { recursive: true });
        await createVideoFixture(join(root, file1080));
        await createVideoFixture(join(root, otherFile));
        const library = await insertLibrary(db, root);
        const first = await scanDirectory(db, library.id, folder);
        const second = await scanDirectory(db, library.id, otherFolder);
        if (!first.itemId || !second.itemId) {
          throw new Error("Scans produced no Items.");
        }
        await setItemProviderIds(db, second.itemId, { tmdb: "78" });

        await expectAuthError(
          runScanJob(db, library.id, folder, [
            {
              kind: "add",
              path: file1080,
              providerIds: { tmdb: "78" },
            },
          ]),
          "CONFLICT",
        );

        const itemRows = await db
          .select()
          .from(items)
          .orderBy(asc(items.canonicalFolder));
        expect(itemRows.map((row) => [row.id, row.canonicalFolder])).toEqual([
          [first.itemId, folder],
          [second.itemId, otherFolder],
        ]);
        const idRows = await db.select().from(providerIds);
        expect(idRows.map((row) => [row.provider, row.itemId])).toEqual([
          ["tmdb", second.itemId],
        ]);
      });
    }));

  test("invalid queued paths reject before any mutation", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(dir, "Alien.1080p.mkv"));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);

        const invalid: ScanChange[] = [
          {
            kind: "add",
            path: "/abs/Alien.mkv",
            providerIds: {},
          },
          {
            kind: "move",
            path: `${folder}/Moved.mkv`,
            previousPath: "../outside.mkv",
            providerIds: {},
          },
          {
            kind: "delete",
            path: ".",
            target: "file",
            providerIds: {},
          },
          {
            kind: "delete",
            path: "",
            target: "item",
            providerIds: {},
          },
        ];
        for (const change of invalid) {
          await expectAuthError(
            runScanJob(db, library.id, folder, [change]),
            "INVALID_INPUT",
          );
        }
        await expectAuthError(
          scanDirectory(db, library.id, folder, {
            changes: [
              {
                kind: "delete",
                path: "has\0nul.mkv",
                target: "item",
                providerIds: {},
              },
            ],
          }),
          "INVALID_INPUT",
        );

        expect(await db.select().from(items)).toHaveLength(1);
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toHaveLength(1);
      });
    }));
});
