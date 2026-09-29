import { describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  artwork,
  files,
  items,
  libraries,
  progress,
  providerIds,
  type ScanChange,
  streams,
  users,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, listJobs } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import {
  readArtworkOriginal,
  storeArtworkOriginal,
} from "../metadata/artwork-store.ts";
import { applyScanChanges, setItemProviderIds } from "./changes.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";
import { scanDirectory, scanShowDirectory } from "./scan.ts";
import { MissingLibraryPathError } from "./walker.ts";

const folder = "Alien (1979) {tmdb-348}";
const file1080 = `${folder}/Alien.1080p.mkv`;
const file2160 = `${folder}/Alien.2160p {edition-Director's Cut}.mkv`;

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP4y8CAFWEXHbQSAPZwP0G2GkFNAAAAAElFTkSuQmCC",
  "base64",
);

const poster = {
  type: "poster",
  url: "https://image.example/poster.png",
} as const;

function respondWith(bytes: Uint8Array): typeof fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(Buffer.from(bytes))) as typeof fetch;
}

async function insertLibrary(
  db: Database,
  rootPath: string,
  medium: "movies" | "shows" = "movies",
) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium, rootPath })
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

async function waitForBlockedUpdate(db: Database) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await db.$client<{ count: number }[]>`
      select count(*)::integer as count from pg_stat_activity
      where wait_event_type = 'Lock'`;
    if ((rows[0]?.count ?? 0) > 0) return;
    if (Date.now() >= deadline) {
      throw new Error("A blocked update was not observed.");
    }
    await Bun.sleep(10);
  }
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

  test("a move change reconciles a destination scanned before it arrived", () =>
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
          positionSeconds: 9,
          playCount: 4,
        });
        await setItemProviderIds(db, itemId, { tmdb: "348" });
        const stored = await storeArtworkOriginal(
          db,
          itemId,
          poster,
          respondWith(png),
        );
        const progressBefore = await db.select().from(progress);

        const movedFolder = "Alien Remastered (1979)";
        const movedPath = `${movedFolder}/Alien.1080p.mkv`;
        await rename(dir, join(root, movedFolder));

        // A poster refresh racing the rename must fail instead of recreating
        // the old canonical folder.
        await expect(
          storeArtworkOriginal(
            db,
            itemId,
            { type: "poster", url: "https://image.example/fresh.jpg" },
            respondWith(png),
          ),
        ).rejects.toThrow();
        await expect(access(dir)).rejects.toThrow();
        await expect(access(join(root, folder, ".pendia"))).rejects.toThrow();

        const temporary = await scanDirectory(db, library.id, movedFolder);
        expect(temporary.itemId).not.toBe(itemId);
        expect(await db.select().from(items)).toHaveLength(2);

        await runScanJob(db, library.id, movedFolder, [
          {
            kind: "move",
            path: movedPath,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows).toHaveLength(1);
        expect(itemRows[0]).toMatchObject({
          id: itemId,
          canonicalFolder: movedFolder,
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
        const idRows = await db.select().from(providerIds);
        expect(idRows.map((row) => [row.provider, row.itemId])).toEqual([
          ["tmdb", itemId],
        ]);
        const artworkRows = await db.select().from(artwork);
        expect(artworkRows).toHaveLength(1);
        expect(artworkRows[0]?.id).toBe(stored.id);
        expect(artworkRows[0]?.storageKey).toBe(
          `${movedFolder}${stored.storageKey.slice(folder.length)}`,
        );
        const original = await readArtworkOriginal(db, stored.id);
        expect(original?.artwork.id).toBe(stored.id);
        expect(Buffer.from(original?.bytes ?? [])).toEqual(png);
        await expect(access(dir)).rejects.toThrow();
      });
    }));

  test("a file-only move keeps readable artwork at its old storage key", () =>
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
          positionSeconds: 9,
          playCount: 4,
        });
        const stored = await storeArtworkOriginal(
          db,
          itemId,
          poster,
          respondWith(png),
        );
        const progressBefore = await db.select().from(progress);

        // A file-only move leaves .pendia behind in the old folder.
        const destinationFolder = "Moved Copies";
        const movedPath = `${destinationFolder}/Alien.1080p.mkv`;
        await mkdir(join(root, destinationFolder), { recursive: true });
        await rename(join(root, file1080), join(root, movedPath));

        await runScanJob(db, library.id, destinationFolder, [
          {
            kind: "move",
            path: movedPath,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows).toHaveLength(1);
        expect(itemRows[0]).toMatchObject({
          id: itemId,
          canonicalFolder: destinationFolder,
        });
        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(1);
        expect(fileRows[0]).toMatchObject({
          id: file.id,
          versionId: version.id,
          itemId,
          path: movedPath,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [version.id],
        );
        expect(await db.select().from(progress)).toEqual(progressBefore);

        const artworkRows = await db.select().from(artwork);
        expect(artworkRows).toHaveLength(1);
        expect(artworkRows[0]).toMatchObject({
          id: stored.id,
          storageKey: stored.storageKey,
          selected: true,
        });
        const original = await readArtworkOriginal(db, stored.id);
        expect(original?.artwork.id).toBe(stored.id);
        expect(Buffer.from(original?.bytes ?? [])).toEqual(png);
        const basename = stored.storageKey.split("/").pop();
        if (basename === undefined) throw new Error("Basename missing.");
        await expect(
          access(join(root, destinationFolder, ".pendia", "artwork", basename)),
        ).rejects.toThrow();
      });
    }));

  test("a batched file swap preserves File, Version, and Progress identity", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileA = file1080;
        const fileB = `${folder}/Alien.720p.mkv`;
        await createVideoFixture(join(root, fileA));
        await createVideoFixture(join(root, fileB));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        const fileRows = await db.select().from(files);
        const versionRows = await db.select().from(versions);
        const rowA = fileRows.find((row) => row.path === fileA);
        const rowB = fileRows.find((row) => row.path === fileB);
        if (!rowA || !rowB || versionRows.length !== 2) {
          throw new Error("Initial scan produced no split Files.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const [viewer] = await db
          .insert(users)
          .values({
            username: "viewer",
            displayName: "Viewer",
            passwordHash: "fixture",
          })
          .returning();
        if (!viewer) throw new Error("Viewer fixture missing.");
        const watchers = [admin.id, viewer.id];
        for (const [index, version] of versionRows.entries()) {
          await db.insert(progress).values({
            userId: watchers[index] ?? "",
            itemId,
            versionId: version.id,
            format: "video",
            positionSeconds: 9,
            playCount: 4,
          });
        }
        const progressBefore = await db.select().from(progress);

        const temporary = join(dir, "swap.temporary.mkv");
        await rename(join(root, fileA), temporary);
        await rename(join(root, fileB), join(root, fileA));
        await rename(temporary, join(root, fileB));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: fileB,
            previousPath: fileA,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileA,
            previousPath: fileB,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(2);
        expect(afterFiles.find((row) => row.path === fileA)?.id).toBe(rowB.id);
        expect(afterFiles.find((row) => row.path === fileB)?.id).toBe(rowA.id);
        expect(afterFiles.find((row) => row.id === rowA.id)).toMatchObject({
          versionId: rowA.versionId,
          itemId,
        });
        expect(afterFiles.find((row) => row.id === rowB.id)).toMatchObject({
          versionId: rowB.versionId,
          itemId,
        });
        expect(
          (await db.select().from(versions)).map((row) => row.id).sort(),
        ).toEqual(versionRows.map((row) => row.id).sort());
        expect(await db.select().from(progress)).toEqual(progressBefore);
        expect(
          afterFiles.some((row) => row.path.startsWith(".pendia-move/")),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(
          (await db.select().from(files))
            .map((row) => [row.id, row.path])
            .sort(),
        ).toEqual(afterFiles.map((row) => [row.id, row.path]).sort());
      });
    }));

  test("an ordered move chain routes the original File through intermediates", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileC = `${folder}/Alien.720p.mkv`;
        await createVideoFixture(join(root, file1080));
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
          positionSeconds: 9,
          playCount: 4,
        });
        const progressBefore = await db.select().from(progress);

        const intermediate = `${folder}/Alien.intermediate.mkv`;
        await rename(join(root, file1080), join(root, fileC));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: intermediate,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileC,
            previousPath: intermediate,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: file.id,
          versionId: version.id,
          itemId,
          path: fileC,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [version.id],
        );
        expect(await db.select().from(progress)).toEqual(progressBefore);
        expect(
          afterFiles.some(
            (row) =>
              row.path === intermediate || row.path.startsWith(".pendia-move/"),
          ),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("an exact repeated move delivery applies once", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileB = `${folder}/Alien.720p.mkv`;
        await createVideoFixture(join(root, file1080));
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
          positionSeconds: 9,
          playCount: 4,
        });
        const progressBefore = await db.select().from(progress);

        await rename(join(root, file1080), join(root, fileB));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: fileB,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileB,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: file.id,
          versionId: version.id,
          itemId,
          path: fileB,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [version.id],
        );
        expect(await db.select().from(progress)).toEqual(progressBefore);
        expect(
          afterFiles.some((row) => row.path.startsWith(".pendia-move/")),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("a reversal chain lands the original File at its final path", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileB = `${folder}/Alien.720p.mkv`;
        await createVideoFixture(join(root, file1080));
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
          positionSeconds: 9,
          playCount: 4,
        });
        const progressBefore = await db.select().from(progress);

        await rename(join(root, file1080), join(root, fileB));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: fileB,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: file1080,
            previousPath: fileB,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileB,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: file.id,
          versionId: version.id,
          itemId,
          path: fileB,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [version.id],
        );
        expect(await db.select().from(progress)).toEqual(progressBefore);
        expect(
          afterFiles.some(
            (row) =>
              row.path === file1080 || row.path.startsWith(".pendia-move/"),
          ),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("an occupied reversal keeps the surviving File at its destination", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileA = file1080;
        const fileB = `${folder}/Alien.720p.mkv`;
        await createVideoFixture(join(root, fileA));
        await createVideoFixture(join(root, fileB));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        const fileRows = await db.select().from(files);
        const versionRows = await db.select().from(versions);
        const rowA = fileRows.find((row) => row.path === fileA);
        const rowB = fileRows.find((row) => row.path === fileB);
        if (!rowA || !rowB || versionRows.length !== 2) {
          throw new Error("Initial scan produced no split Files.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const [viewer] = await db
          .insert(users)
          .values({
            username: "viewer",
            displayName: "Viewer",
            passwordHash: "fixture",
          })
          .returning();
        if (!viewer) throw new Error("Viewer fixture missing.");
        const watchers = [admin.id, viewer.id];
        for (const [index, version] of versionRows.entries()) {
          await db.insert(progress).values({
            userId: watchers[index] ?? "",
            itemId,
            versionId: version.id,
            format: "video",
            positionSeconds: 9,
            playCount: 4,
          });
        }
        const progressBefore = await db.select().from(progress);

        // rename overwrites: the surviving bytes at fileB belong to A.
        await rename(join(root, fileA), join(root, fileB));
        await rename(join(root, fileB), join(root, fileA));
        await rename(join(root, fileA), join(root, fileB));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: fileB,
            previousPath: fileA,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileA,
            previousPath: fileB,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileB,
            previousPath: fileA,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: rowA.id,
          versionId: rowA.versionId,
          itemId,
          path: fileB,
        });
        const afterVersions = await db.select().from(versions);
        expect(afterVersions.map((row) => row.id)).toEqual([rowA.versionId]);
        const survivingProgress = progressBefore.find(
          (row) => row.versionId === rowA.versionId,
        );
        const detachedProgress = progressBefore.find(
          (row) => row.versionId === rowB.versionId,
        );
        if (!survivingProgress || !detachedProgress) {
          throw new Error("Progress fixture missing.");
        }
        // Version deletion detaches Progress through progress_version_fk.
        const afterProgress = await db.select().from(progress);
        expect(afterProgress).toHaveLength(2);
        expect(
          afterProgress.find((row) => row.id === survivingProgress.id),
        ).toEqual(survivingProgress);
        expect(
          afterProgress.find((row) => row.id === detachedProgress.id),
        ).toEqual({ ...detachedProgress, versionId: null });
        expect(
          afterFiles.some(
            (row) =>
              row.path === fileA ||
              row.id === rowB.id ||
              row.path.startsWith(".pendia-move/"),
          ),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("a repeated source after a chain does not reuse the parked row", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileB = `${folder}/Alien.intermediate.mkv`;
        const fileC = `${folder}/Alien.720p.mkv`;
        await createVideoFixture(join(root, file1080));
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
          positionSeconds: 9,
          playCount: 4,
        });
        const progressBefore = await db.select().from(progress);

        await rename(join(root, file1080), join(root, fileC));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: fileB,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileC,
            previousPath: fileB,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileB,
            previousPath: file1080,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: file.id,
          versionId: version.id,
          itemId,
          path: fileC,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [version.id],
        );
        expect(await db.select().from(progress)).toEqual(progressBefore);
        expect(
          afterFiles.some(
            (row) =>
              row.path === file1080 ||
              row.path === fileB ||
              row.path.startsWith(".pendia-move/"),
          ),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("duplicate move sources or destinations reject INVALID_INPUT", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        await createVideoFixture(join(root, file2160));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);
        const filesBefore = await db.select().from(files);
        const batches: ScanChange[][] = [
          [
            {
              kind: "move",
              path: `${folder}/copy-one.mkv`,
              previousPath: file1080,
              providerIds: {},
            },
            {
              kind: "move",
              path: `${folder}/copy-two.mkv`,
              previousPath: file1080,
              providerIds: {},
            },
          ],
          [
            {
              kind: "move",
              path: `${folder}/copy-one.mkv`,
              previousPath: file1080,
              providerIds: {},
            },
            {
              kind: "move",
              path: `${folder}/copy-one.mkv`,
              previousPath: file2160,
              providerIds: {},
            },
          ],
        ];
        for (const changes of batches) {
          const error = await applyScanChanges(db, library.id, changes).catch(
            (cause: unknown) => cause,
          );
          expect(error).toBeInstanceOf(AuthError);
          expect((error as AuthError).code).toBe("INVALID_INPUT");
        }
        expect(await db.select().from(files)).toEqual(filesBefore);
        const repeated = await applyScanChanges(db, library.id, [
          {
            kind: "move",
            path: `${folder}/repeated.mkv`,
            previousPath: file1080,
            providerIds: {},
          },
          {
            kind: "move",
            path: `${folder}/repeated.mkv`,
            previousPath: file1080,
            providerIds: {},
          },
        ]);
        expect(Array.isArray(repeated)).toBe(true);
        const afterFiles = await db.select().from(files);
        expect(
          afterFiles.find((row) => row.id === filesBefore[0]?.id)?.path,
        ).toBe(`${folder}/repeated.mkv`);
      });
    }));

  test("move pairs with colliding concatenations keep distinct destinations", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const short = `${folder}/x.mkv`;
        const long = `${folder}/x.mkv2.mkv`;
        // `${long}` + `${folder}/done.mkv` and
        // `${short}` + `2.mkv${folder}/done.mkv` produce the same raw string.
        const longDestination = `${folder}/done.mkv`;
        const shortDestination = `2.mkv${folder}/done.mkv`;
        expect(`${long}${longDestination}`).toBe(`${short}${shortDestination}`);
        await createVideoFixture(join(root, short));
        await createVideoFixture(join(root, long));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);
        const fileRows = await db.select().from(files);
        const rowShort = fileRows.find((row) => row.path === short);
        const rowLong = fileRows.find((row) => row.path === long);
        if (!rowShort || !rowLong) {
          throw new Error("Initial scan produced no split Files.");
        }
        await applyScanChanges(db, library.id, [
          {
            kind: "move",
            path: longDestination,
            previousPath: long,
            providerIds: {},
          },
          {
            kind: "move",
            path: shortDestination,
            previousPath: short,
            providerIds: {},
          },
        ]);
        const afterFiles = await db.select().from(files);
        expect(afterFiles.find((row) => row.id === rowLong.id)?.path).toBe(
          longDestination,
        );
        expect(afterFiles.find((row) => row.id === rowShort.id)?.path).toBe(
          shortDestination,
        );
      });
    }));

  test("a move onto another item's file removes only the displaced leaf", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const foundationDir = join(root, "Foundation", "Season 01");
        const severanceDir = join(root, "Severance", "Season 01");
        await mkdir(foundationDir, { recursive: true });
        await mkdir(severanceDir, { recursive: true });
        const displacedPath = "Foundation/Season 01/Foundation S01E01.mkv";
        const siblingPath = "Foundation/Season 01/Foundation S01E02.mkv";
        const sourcePath = "Severance/Season 01/Severance S01E01.mkv";
        await createVideoFixture(join(root, displacedPath));
        await createVideoFixture(join(root, siblingPath));
        await createVideoFixture(join(root, sourcePath));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        await scanShowDirectory(db, library.id, "Severance");

        const [displacedFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, displacedPath));
        const [siblingFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, siblingPath));
        const [sourceFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, sourcePath));
        if (!displacedFile || !siblingFile || !sourceFile) {
          throw new Error("Initial scan produced no Episode Files.");
        }
        const beforeItems = await db.select().from(items);
        const showRoot = beforeItems.find(
          (row) => row.kind === "show" && row.canonicalFolder === "Foundation",
        );
        const season = beforeItems.find(
          (row) =>
            row.kind === "season" &&
            row.canonicalFolder === "Foundation/Season 01",
        );
        if (!showRoot || !season) {
          throw new Error("Initial scan produced no Show or Season.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId: siblingFile.itemId,
          versionId: siblingFile.versionId,
          format: "video",
          positionSeconds: 33,
        });
        const progressBefore = await db.select().from(progress);

        await db.transaction(async (tx) => {
          await applyScanChanges(tx, library.id, [
            {
              kind: "move",
              path: displacedPath,
              previousPath: sourcePath,
              providerIds: {},
            },
          ]);
        });

        const itemRows = await db.select().from(items);
        expect(
          itemRows.find((row) => row.id === displacedFile.itemId),
        ).toBeUndefined();
        expect(itemRows.find((row) => row.id === showRoot.id)).toBeDefined();
        expect(itemRows.find((row) => row.id === season.id)).toBeDefined();
        expect(
          itemRows.find((row) => row.id === siblingFile.itemId),
        ).toBeDefined();
        expect(
          itemRows.find((row) => row.id === sourceFile.itemId),
        ).toBeDefined();
        const afterFiles = await db.select().from(files);
        expect(
          afterFiles.find((row) => row.path === displacedPath),
        ).toMatchObject({ id: sourceFile.id, itemId: sourceFile.itemId });
        expect(
          afterFiles.find((row) => row.path === siblingPath),
        ).toMatchObject({
          id: siblingFile.id,
          versionId: siblingFile.versionId,
          itemId: siblingFile.itemId,
        });
        expect(
          afterFiles.find((row) => row.id === displacedFile.id),
        ).toBeUndefined();
        expect(await db.select().from(progress)).toEqual(progressBefore);
      });
    }));

  test("a scan job fails without deleting rows when the root vanished", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);
        const [version] = await db.select().from(versions);
        const itemRows = await db.select().from(items);
        const fileRows = await db.select().from(files);
        if (!version || itemRows.length === 0 || fileRows.length === 0) {
          throw new Error("Initial scan produced no rows.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId: itemRows[0]?.id ?? "",
          versionId: version.id,
          format: "video",
          positionSeconds: 21,
        });
        const progressRows = await db.select().from(progress);

        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: folder },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const moved = `${root}-unavailable`;
        await rename(root, moved);
        try {
          const claimed = await queue.claim();
          if (!claimed) throw new Error("Scan job was not claimed.");
          const failure = await registry.run(claimed).then(
            () => undefined as unknown,
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(MissingLibraryPathError);
          expect((failure as MissingLibraryPathError).scope).toBe("root");
          await queue.fail(claimed, failure);
        } finally {
          await rename(moved, root);
        }

        expect(await db.select().from(items)).toEqual(itemRows);
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toEqual(fileRows);
        expect(await db.select().from(progress)).toEqual(progressRows);
      });
    }));

  test("a manual root scan fans out to an Item folder missing on disk", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        await scanDirectory(db, library.id, folder);
        await rm(dir, { recursive: true });

        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "." },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const claimedRoot = await queue.claim();
        if (!claimedRoot) throw new Error("Root job was not claimed.");
        await registry.run(claimedRoot);
        await queue.complete(claimedRoot);

        const fanned = await listJobs(db, { state: "queued", type: "scan" });
        expect(fanned.map((job) => job.payload)).toEqual([
          {
            type: "scan",
            libraryId: library.id,
            path: folder,
            reconcileMissing: true,
          },
        ]);
        const claimedChild = await queue.claim();
        if (!claimedChild) throw new Error("Child job was not claimed.");
        await registry.run(claimedChild);
        await queue.complete(claimedChild);

        expect(await db.select().from(items)).toEqual([]);
        expect(await db.select().from(versions)).toEqual([]);
        expect(await db.select().from(files)).toEqual([]);
        expect(await db.select().from(streams)).toEqual([]);
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

  test("only reconcileMissing removes a file missing on disk", () =>
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
        expect(await db.select().from(versions)).toHaveLength(2);
        expect(await db.select().from(files)).toHaveLength(2);

        await scanDirectory(db, library.id, folder, {
          reconcileMissing: true,
        });
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).toEqual([kept.versionId]);
        const remainingFiles = await db.select().from(files);
        expect(remainingFiles.map((row) => row.id)).toEqual([kept.id]);
      });
    }));

  test("only reconcileMissing removes an Item whose only file vanished", () =>
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

        expect(await db.select().from(items)).toHaveLength(1);
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toHaveLength(1);

        await scanDirectory(db, library.id, folder, {
          reconcileMissing: true,
        });
        expect(await db.select().from(items)).toEqual([]);
        expect(await db.select().from(versions)).toEqual([]);
        expect(await db.select().from(files)).toEqual([]);
        expect(await db.select().from(streams)).toEqual([]);
      });
    }));

  test("a reconcile-missing scan removes colocated artwork after the Item delete commits", () =>
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
        const stored = await storeArtworkOriginal(
          db,
          itemId,
          poster,
          respondWith(png),
        );
        const target = join(root, stored.storageKey);
        expect(await readFile(target)).toEqual(png);

        await rm(join(root, file1080));
        await scanDirectory(db, library.id, folder, {
          reconcileMissing: true,
        });

        expect(await db.select().from(items)).toEqual([]);
        expect(await db.select().from(artwork)).toEqual([]);
        await expect(access(target)).rejects.toThrow();
      });
    }));

  test("a reconcile delete collects artwork committed under the subtree lock", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(root, file1080));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        await rm(join(root, file1080));

        const second = createDatabase(url);
        try {
          let markLocked = () => {};
          const lockHeld = new Promise<void>((resolve) => {
            markLocked = resolve;
          });
          const writer = second.db.transaction(async (tx) => {
            const [item] = await tx
              .select({ id: items.id })
              .from(items)
              .where(eq(items.id, itemId))
              .for("update");
            if (!item) throw new Error("Fixture Item missing.");
            markLocked();
            await waitForBlockedUpdate(db);
            const storageKey = `${folder}/.pendia/artwork/${Bun.randomUUIDv7()}`;
            await tx.insert(artwork).values({
              itemId,
              versionId: null,
              type: "poster",
              sourceUrl: poster.url,
              backend: "colocated",
              storageKey,
              selected: true,
            });
            await mkdir(dirname(join(root, storageKey)), {
              recursive: true,
            });
            await writeFile(join(root, storageKey), png);
            return storageKey;
          });
          await lockHeld;
          const scanning = scanDirectory(db, library.id, folder, {
            reconcileMissing: true,
          });
          const storageKey = await writer;
          await scanning;

          expect(await db.select().from(items)).toEqual([]);
          expect(await db.select().from(artwork)).toEqual([]);
          await expect(access(join(root, storageKey))).rejects.toThrow();
        } finally {
          await second.close();
        }
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
          ["tmdb", first.itemId],
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

  test("a show file-delete removes the Episode and keeps its containers", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const seasonDir = join(root, "Foundation", "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const deletedPath = "Foundation/Season 01/Foundation S01E01.mkv";
        const keptPath = "Foundation/Season 01/Foundation S01E02.mkv";
        await createVideoFixture(join(root, deletedPath));
        await createVideoFixture(join(root, keptPath));
        const library = await insertLibrary(db, root, "shows");
        const scanned = await scanShowDirectory(db, library.id, "Foundation");
        const showId = scanned.itemId;
        if (!showId) throw new Error("Initial scan produced no Show.");
        const [deletedFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, deletedPath));
        if (!deletedFile) {
          throw new Error("Initial scan produced no Episode File.");
        }
        const episodeId = deletedFile.itemId;
        const deletedVersionId = deletedFile.versionId;
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId: episodeId,
          versionId: deletedVersionId,
          format: "video",
          positionSeconds: 33,
        });
        await setItemProviderIds(db, showId, {
          tvdb: "366972",
          tmdb: "106379",
          imdb: "tt0804484",
        });

        await rm(join(root, deletedPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "delete",
            path: deletedPath,
            target: "file",
            providerIds: { tvdb: "366972" },
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.kind).sort()).toEqual([
          "episode",
          "season",
          "show",
        ]);
        expect(itemRows.find((row) => row.kind === "show")?.id).toBe(showId);
        expect(itemRows.find((row) => row.id === episodeId)).toBeUndefined();
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).not.toContain(
          deletedVersionId,
        );
        expect(versionRows).toHaveLength(1);
        const fileRows = await db.select().from(files);
        expect(fileRows.map((row) => row.path)).toEqual([keptPath]);
        expect(await db.select().from(progress)).toEqual([]);
        const idRows = await db
          .select()
          .from(providerIds)
          .orderBy(asc(providerIds.provider));
        expect(idRows.map((row) => [row.provider, row.itemId])).toEqual([
          ["imdb", showId],
          ["tmdb", showId],
          ["tvdb", showId],
        ]);
      });
    }));

  test("a show file-delete on a split Version removes only that File", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const seasonDir = join(root, "Foundation", "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const keptPath = "Foundation/Season 01/Foundation S01E01 - part1.mkv";
        const deletedPath =
          "Foundation/Season 01/Foundation S01E01 - part2.mkv";
        await createVideoFixture(join(root, keptPath));
        await createVideoFixture(join(root, deletedPath));
        const library = await insertLibrary(db, root, "shows");
        const scanned = await scanShowDirectory(db, library.id, "Foundation");
        const showId = scanned.itemId;
        if (!showId) throw new Error("Initial scan produced no Show.");
        const [keptFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, keptPath));
        const [deletedFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, deletedPath));
        if (
          !keptFile ||
          !deletedFile ||
          keptFile.versionId !== deletedFile.versionId
        ) {
          throw new Error("Initial scan produced no split Episode Files.");
        }
        const episodeId = keptFile.itemId;
        const versionId = keptFile.versionId;
        const seasonId = (await db.select().from(items)).find(
          (row) => row.kind === "season",
        )?.id;
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId: episodeId,
          versionId,
          format: "video",
          positionSeconds: 33,
        });
        const progressBefore = await db.select().from(progress);

        await rm(join(root, deletedPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "delete",
            path: deletedPath,
            target: "file",
            providerIds: { tvdb: "366972" },
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.kind).sort()).toEqual([
          "episode",
          "season",
          "show",
        ]);
        expect(itemRows.find((row) => row.kind === "show")?.id).toBe(showId);
        expect(itemRows.find((row) => row.kind === "season")?.id).toBe(
          seasonId,
        );
        expect(itemRows.find((row) => row.kind === "episode")?.id).toBe(
          episodeId,
        );
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).toEqual([versionId]);
        expect(versionRows[0]?.bytes).toBe(keptFile.bytes);
        const fileRows = await db.select().from(files);
        expect(fileRows.map((row) => row.id)).toEqual([keptFile.id]);
        expect(fileRows[0]?.path).toBe(keptPath);
        expect(fileRows[0]?.order).toBe(0);
        expect(await db.select().from(progress)).toEqual(progressBefore);
      });
    }));

  test("a move over one File in a split Version keeps the Version and sibling", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const seasonDir = join(root, "Foundation", "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const part1Path = "Foundation/Season 01/Foundation S01E01 - part1.mkv";
        const part2Path = "Foundation/Season 01/Foundation S01E01 - part2.mkv";
        const part3Path = "Foundation/Season 01/Foundation S01E01 - part3.mkv";
        await createVideoFixture(join(root, part1Path));
        await createVideoFixture(join(root, part2Path));
        await createVideoFixture(join(root, part3Path));
        const library = await insertLibrary(db, root, "shows");
        const scanned = await scanShowDirectory(db, library.id, "Foundation");
        const showId = scanned.itemId;
        if (!showId) throw new Error("Initial scan produced no Show.");
        const initialFiles = await db
          .select()
          .from(files)
          .orderBy(asc(files.order));
        const [part1File, part2File, part3File] = initialFiles;
        if (
          !part1File ||
          !part2File ||
          !part3File ||
          part1File.versionId !== part2File.versionId ||
          part1File.versionId !== part3File.versionId
        ) {
          throw new Error("Initial scan produced no split Episode Files.");
        }
        const episodeId = part1File.itemId;
        const versionId = part1File.versionId;
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId: episodeId,
          versionId,
          format: "video",
          positionSeconds: 33,
        });
        const progressBefore = await db.select().from(progress);

        await rename(join(root, part3Path), join(root, part2Path));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: part2Path,
            previousPath: part3Path,
            providerIds: {},
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.kind).sort()).toEqual([
          "episode",
          "season",
          "show",
        ]);
        expect(itemRows.find((row) => row.kind === "show")?.id).toBe(showId);
        expect(itemRows.find((row) => row.kind === "episode")?.id).toBe(
          episodeId,
        );
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).toEqual([versionId]);
        const fileRows = await db
          .select()
          .from(files)
          .orderBy(asc(files.order));
        expect(
          fileRows.map((row) => ({
            id: row.id,
            path: row.path,
            order: row.order,
          })),
        ).toEqual([
          { id: part1File.id, path: part1Path, order: 0 },
          { id: part3File.id, path: part2Path, order: 1 },
        ]);
        expect(await db.select().from(progress)).toEqual(progressBefore);
      });
    }));

  test("a show folder rename keeps hierarchy identity and canonical folders", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const oldShow = "Old Show";
        const newShow = "New Show";
        const seasonDir = join(root, oldShow, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const oldPath = `${oldShow}/Season 01/Show S01E01.mkv`;
        const newPath = `${newShow}/Season 01/Show S01E01.mkv`;
        await createVideoFixture(join(root, oldPath));
        const library = await insertLibrary(db, root, "shows");
        const scanned = await scanShowDirectory(db, library.id, oldShow);
        const showId = scanned.itemId;
        if (!showId) throw new Error("Initial scan produced no Show.");
        const itemBefore = await db.select().from(items);
        const seasonId = itemBefore.find((row) => row.kind === "season")?.id;
        const episodeId = itemBefore.find((row) => row.kind === "episode")?.id;
        const [file] = await db.select().from(files);
        if (!seasonId || !episodeId || !file) {
          throw new Error("Initial scan produced no hierarchy.");
        }
        const versionId = file.versionId;
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId: episodeId,
          versionId,
          format: "video",
          positionSeconds: 33,
        });
        const showProviderIds = {
          tvdb: "366972",
          tmdb: "106379",
          imdb: "tt0804484",
        };
        await setItemProviderIds(db, showId, showProviderIds);
        const progressBefore = await db.select().from(progress);

        await rename(join(root, oldShow), join(root, newShow));
        const temporary = await scanShowDirectory(db, library.id, newShow);
        expect(temporary.itemId).not.toBe(showId);
        expect(await db.select().from(items)).toHaveLength(6);

        await runScanJob(db, library.id, newShow, [
          {
            kind: "move",
            path: newPath,
            previousPath: oldPath,
            providerIds: showProviderIds,
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows).toHaveLength(3);
        const show = itemRows.find((row) => row.kind === "show");
        const season = itemRows.find((row) => row.kind === "season");
        const episode = itemRows.find((row) => row.kind === "episode");
        expect(show?.id).toBe(showId);
        expect(show?.canonicalFolder).toBe(newShow);
        expect(season?.id).toBe(seasonId);
        expect(season?.canonicalFolder).toBe(`${newShow}/Season 01`);
        expect(episode?.id).toBe(episodeId);
        expect(episode?.canonicalFolder).toBe(`${newShow}/Season 01`);
        const versionRows = await db.select().from(versions);
        expect(versionRows.map((row) => row.id)).toEqual([versionId]);
        const fileRows = await db.select().from(files);
        expect(fileRows.map((row) => row.id)).toEqual([file.id]);
        expect(fileRows[0]?.path).toBe(newPath);
        expect(await db.select().from(progress)).toEqual(progressBefore);
        const idRows = await db
          .select()
          .from(providerIds)
          .orderBy(asc(providerIds.provider));
        expect(idRows.map((row) => [row.provider, row.itemId])).toEqual([
          ["imdb", showId],
          ["tmdb", showId],
          ["tvdb", showId],
        ]);
      });
    }));
});
