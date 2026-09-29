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
import { and, asc, eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  artwork,
  contributors,
  credits,
  episodes,
  favourites,
  files,
  items,
  libraries,
  progress,
  providerIds,
  ratings,
  type ScanChange,
  sessionRegistry,
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

  test("an overwrite chain keeps the surviving File at the final path", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileA = file1080;
        const fileB = `${folder}/Alien.720p.mkv`;
        const fileC = `${folder}/Alien.2160p.mkv`;
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

        // rename overwrites: B's bytes are destroyed, A's bytes land at C.
        await rename(join(root, fileA), join(root, fileB));
        await rename(join(root, fileB), join(root, fileC));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: fileB,
            previousPath: fileA,
            providerIds: { tmdb: "348" },
          },
          {
            kind: "move",
            path: fileC,
            previousPath: fileB,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: rowA.id,
          versionId: rowA.versionId,
          itemId,
          path: fileC,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [rowA.versionId],
        );
        const surviving = progressBefore.find(
          (row) => row.versionId === rowA.versionId,
        );
        const detached = progressBefore.find(
          (row) => row.versionId === rowB.versionId,
        );
        if (!surviving || !detached) {
          throw new Error("Progress fixture missing.");
        }
        const afterProgress = await db.select().from(progress);
        expect(afterProgress).toHaveLength(2);
        expect(afterProgress.find((row) => row.id === surviving.id)).toEqual(
          surviving,
        );
        expect(afterProgress.find((row) => row.id === detached.id)).toEqual({
          ...detached,
          versionId: null,
        });
        expect(
          afterFiles.some(
            (row) =>
              row.path === fileA ||
              row.path === fileB ||
              row.path.startsWith(".pendia-move/"),
          ),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("an occupied three-hop chain keeps only the first surviving File", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const fileA = file1080;
        const fileB = `${folder}/Alien.720p.mkv`;
        const fileC = `${folder}/Alien.2160p.mkv`;
        const fileD = `${folder}/Alien.4k.mkv`;
        await createVideoFixture(join(root, fileA));
        await createVideoFixture(join(root, fileB));
        await createVideoFixture(join(root, fileC));
        const library = await insertLibrary(db, root);
        const scanned = await scanDirectory(db, library.id, folder);
        const itemId = scanned.itemId;
        if (!itemId) throw new Error("Initial scan produced no Item.");
        const fileRows = await db.select().from(files);
        const versionRows = await db.select().from(versions);
        const rowA = fileRows.find((row) => row.path === fileA);
        const rowB = fileRows.find((row) => row.path === fileB);
        const rowC = fileRows.find((row) => row.path === fileC);
        if (!rowA || !rowB || !rowC || versionRows.length !== 3) {
          throw new Error("Initial scan produced no split Files.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const watchers = [admin.id];
        for (const username of ["viewer", "guest"]) {
          const [user] = await db
            .insert(users)
            .values({
              username,
              displayName: username,
              passwordHash: "fixture",
            })
            .returning();
          if (!user) throw new Error("User fixture missing.");
          watchers.push(user.id);
        }
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

        // rename overwrites: only A's bytes survive, at D.
        await rename(join(root, fileA), join(root, fileB));
        await rename(join(root, fileB), join(root, fileC));
        await rename(join(root, fileC), join(root, fileD));

        await runScanJob(db, library.id, folder, [
          {
            kind: "move",
            path: fileB,
            previousPath: fileA,
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
            path: fileD,
            previousPath: fileC,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: rowA.id,
          versionId: rowA.versionId,
          itemId,
          path: fileD,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [rowA.versionId],
        );
        const surviving = progressBefore.find(
          (row) => row.versionId === rowA.versionId,
        );
        const detachedIds = [rowB.versionId, rowC.versionId];
        if (!surviving) throw new Error("Progress fixture missing.");
        const afterProgress = await db.select().from(progress);
        expect(afterProgress).toHaveLength(3);
        expect(afterProgress.find((row) => row.id === surviving.id)).toEqual(
          surviving,
        );
        for (const versionId of detachedIds) {
          const detached = progressBefore.find(
            (row) => row.versionId === versionId,
          );
          if (!detached) throw new Error("Progress fixture missing.");
          expect(afterProgress.find((row) => row.id === detached.id)).toEqual({
            ...detached,
            versionId: null,
          });
        }
        expect(
          afterFiles.some(
            (row) =>
              row.path === fileA ||
              row.path === fileB ||
              row.path === fileC ||
              row.path.startsWith(".pendia-move/"),
          ),
        ).toBe(false);

        const rescanned = await scanDirectory(db, library.id, folder);
        expect(rescanned.itemId).toBe(itemId);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("a repeated reverse move keeps the first surviving identity", () =>
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

        // rename overwrites: B's bytes are destroyed and A's bytes return to A.
        await rename(join(root, fileA), join(root, fileB));
        await rename(join(root, fileB), join(root, fileA));

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
            path: fileA,
            previousPath: fileB,
            providerIds: { tmdb: "348" },
          },
        ]);

        const afterFiles = await db.select().from(files);
        expect(afterFiles).toHaveLength(1);
        expect(afterFiles[0]).toMatchObject({
          id: rowA.id,
          versionId: rowA.versionId,
          itemId,
          path: fileA,
        });
        expect((await db.select().from(versions)).map((row) => row.id)).toEqual(
          [rowA.versionId],
        );
        const surviving = progressBefore.find(
          (row) => row.versionId === rowA.versionId,
        );
        const detached = progressBefore.find(
          (row) => row.versionId === rowB.versionId,
        );
        if (!surviving || !detached) {
          throw new Error("Progress fixture missing.");
        }
        const afterProgress = await db.select().from(progress);
        expect(afterProgress).toHaveLength(2);
        expect(afterProgress.find((row) => row.id === surviving.id)).toEqual(
          surviving,
        );
        expect(afterProgress.find((row) => row.id === detached.id)).toEqual({
          ...detached,
          versionId: null,
        });
        expect(
          afterFiles.some(
            (row) => row.path === fileB || row.path.startsWith(".pendia-move/"),
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
        const severanceContainers = beforeItems
          .filter(
            (row) =>
              row.kind !== "episode" &&
              row.canonicalFolder.startsWith("Severance"),
          )
          .map((row) => row.id);
        if (!showRoot || !season || severanceContainers.length === 0) {
          throw new Error("Initial scan produced no Show hierarchies.");
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
        await db.insert(progress).values({
          userId: admin.id,
          itemId: sourceFile.itemId,
          versionId: sourceFile.versionId,
          format: "video",
          positionSeconds: 33,
        });
        await db.insert(progress).values({
          userId: viewer.id,
          itemId: siblingFile.itemId,
          versionId: siblingFile.versionId,
          format: "video",
          positionSeconds: 44,
          playCount: 2,
        });
        const progressBefore = await db.select().from(progress);
        const siblingProgress = progressBefore.find(
          (row) => row.versionId === siblingFile.versionId,
        );
        const sourceProgress = progressBefore.find(
          (row) => row.versionId === sourceFile.versionId,
        );
        if (!siblingProgress || !sourceProgress) {
          throw new Error("Progress fixture missing.");
        }
        const [sourceSession] = await db
          .insert(sessionRegistry)
          .values({
            userId: admin.id,
            itemId: sourceFile.itemId,
            versionId: sourceFile.versionId,
            playMethod: "direct-play",
            state: "playing",
          })
          .returning();
        if (!sourceSession) {
          throw new Error("Session fixture missing.");
        }
        const [sourceVersion] = await db
          .select()
          .from(versions)
          .where(eq(versions.id, sourceFile.versionId));
        if (sourceVersion?.segmentTimelineId == null) {
          throw new Error("Source Version has no segment timeline.");
        }
        const [storedVersion] = await db
          .insert(versions)
          .values({
            itemId: sourceFile.itemId,
            itemKind: "episode",
            libraryId: library.id,
            label: "Stored 720p",
            format: "video",
            bytes: 1n,
            origin: "stored",
            sourceFileId: sourceFile.id,
            segmentTimelineId: sourceVersion.segmentTimelineId,
            timelineAligned: true,
            storedFolder: "/stored/episode",
            rung: "720p",
            complete: true,
          })
          .returning();
        if (!storedVersion) throw new Error("Stored Version missing.");

        await rename(join(root, sourcePath), join(root, displacedPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: displacedPath,
            previousPath: sourcePath,
            providerIds: {},
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(
          itemRows.find((row) => row.id === displacedFile.itemId),
        ).toBeUndefined();
        // The emptied Severance containers are pruned, but its Episode Item
        // itself is preserved as the destination Episode.
        expect(
          severanceContainers.filter(
            (id) => itemRows.find((row) => row.id === id) !== undefined,
          ),
        ).toEqual([]);
        expect(itemRows.find((row) => row.id === showRoot.id)).toBeDefined();
        expect(itemRows.find((row) => row.id === season.id)).toBeDefined();
        expect(
          itemRows.find((row) => row.id === siblingFile.itemId),
        ).toBeDefined();
        const destinationEpisode = itemRows.find(
          (row) =>
            row.kind === "episode" &&
            row.parentId === season.id &&
            row.id !== siblingFile.itemId,
        );
        expect(destinationEpisode?.id).toBe(sourceFile.itemId);
        const afterFiles = await db.select().from(files);
        const movedFile = afterFiles.find((row) => row.path === displacedPath);
        if (!destinationEpisode || !movedFile) {
          throw new Error("Scan produced no destination Episode.");
        }
        expect(movedFile).toMatchObject({
          id: sourceFile.id,
          versionId: sourceFile.versionId,
          itemId: destinationEpisode.id,
        });
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
        expect(
          afterFiles.some(
            (row) =>
              row.path === sourcePath || row.path.startsWith(".pendia-move/"),
          ),
        ).toBe(false);
        const afterProgress = await db.select().from(progress);
        expect(afterProgress).toHaveLength(2);
        expect(
          afterProgress.find((row) => row.id === siblingProgress.id),
        ).toEqual(siblingProgress);
        expect(
          afterProgress.find((row) => row.id === sourceProgress.id),
        ).toEqual({ ...sourceProgress, itemId: destinationEpisode.id });
        expect(await db.select().from(sessionRegistry)).toEqual([
          { ...sourceSession, itemId: destinationEpisode.id },
        ]);
        const afterVersions = await db.select().from(versions);
        expect(
          afterVersions.find((row) => row.id === sourceFile.versionId)?.itemId,
        ).toBe(destinationEpisode.id);
        expect(
          afterVersions.find((row) => row.id === displacedFile.versionId),
        ).toBeUndefined();
        expect(
          afterVersions.find((row) => row.id === storedVersion.id),
        ).toMatchObject({ itemId: sourceFile.itemId });

        const rescanned = await scanShowDirectory(db, library.id, "Foundation");
        expect(rescanned.itemId).toBe(showRoot.id);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("a non-colliding cross-show move keeps the fresher Progress", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const foundationDir = join(root, "Foundation", "Season 01");
        const severanceDir = join(root, "Severance", "Season 01");
        await mkdir(foundationDir, { recursive: true });
        await mkdir(severanceDir, { recursive: true });
        const destinationPath = "Foundation/Season 01/Foundation S01E01.mkv";
        const movedPath = "Foundation/Season 01/Foundation S01E01 - Alt.mkv";
        const sourcePath = "Severance/Season 01/Severance S01E01.mkv";
        await createVideoFixture(join(root, destinationPath));
        await createVideoFixture(join(root, sourcePath));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        await scanShowDirectory(db, library.id, "Severance");

        const [destinationFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, destinationPath));
        const [sourceFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, sourcePath));
        if (!destinationFile || !sourceFile) {
          throw new Error("Initial scan produced no Episode Files.");
        }
        const beforeItems = await db.select().from(items);
        const showRoot = beforeItems.find(
          (row) => row.kind === "show" && row.canonicalFolder === "Foundation",
        );
        const severanceItems = beforeItems
          .filter((row) => row.canonicalFolder.startsWith("Severance"))
          .map((row) => row.id);
        if (!showRoot || severanceItems.length === 0) {
          throw new Error("Initial scan produced no Show hierarchies.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const [destinationProgress] = await db
          .insert(progress)
          .values({
            userId: admin.id,
            itemId: destinationFile.itemId,
            versionId: destinationFile.versionId,
            format: "video",
            positionSeconds: 11,
            updatedAt: new Date("2020-01-01T00:00:00Z"),
          })
          .returning();
        const [sourceVersion] = await db
          .select()
          .from(versions)
          .where(eq(versions.id, sourceFile.versionId));
        if (sourceVersion?.segmentTimelineId == null) {
          throw new Error("Source Version has no segment timeline.");
        }
        const [storedVersion] = await db
          .insert(versions)
          .values({
            itemId: sourceFile.itemId,
            itemKind: "episode",
            libraryId: library.id,
            label: "Stored 720p",
            format: "video",
            bytes: 1n,
            origin: "stored",
            sourceFileId: sourceFile.id,
            segmentTimelineId: sourceVersion.segmentTimelineId,
            timelineAligned: true,
            storedFolder: "/stored/episode",
            rung: "720p",
            complete: true,
          })
          .returning();
        if (!storedVersion) throw new Error("Stored Version missing.");
        const [sourceProgress] = await db
          .insert(progress)
          .values({
            userId: admin.id,
            itemId: sourceFile.itemId,
            versionId: storedVersion.id,
            format: "video",
            positionSeconds: 22,
            updatedAt: new Date("2024-01-01T00:00:00Z"),
          })
          .returning();
        if (!destinationProgress || !sourceProgress) {
          throw new Error("Progress fixture missing.");
        }

        await rename(join(root, sourcePath), join(root, movedPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: movedPath,
            previousPath: sourcePath,
            providerIds: {},
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(
          severanceItems.filter(
            (id) => itemRows.find((row) => row.id === id) !== undefined,
          ),
        ).toEqual([]);
        expect(itemRows.find((row) => row.id === showRoot.id)).toBeDefined();
        const afterFiles = await db.select().from(files);
        const movedFile = afterFiles.find((row) => row.path === movedPath);
        if (!movedFile) throw new Error("Moved File missing.");
        expect(movedFile).toMatchObject({
          id: sourceFile.id,
          versionId: sourceFile.versionId,
          itemId: destinationFile.itemId,
        });
        expect(
          afterFiles.find((row) => row.path === destinationPath),
        ).toMatchObject({
          id: destinationFile.id,
          versionId: destinationFile.versionId,
          itemId: destinationFile.itemId,
        });
        const afterVersions = await db.select().from(versions);
        const destinationVersions = afterVersions.filter(
          (row) => row.itemId === destinationFile.itemId,
        );
        expect(destinationVersions.map((row) => row.id).sort()).toEqual(
          [sourceFile.versionId, destinationFile.versionId].sort(),
        );
        expect(
          afterVersions.find((row) => row.id === sourceFile.versionId)?.itemId,
        ).toBe(destinationFile.itemId);
        expect(
          afterVersions.find((row) => row.id === storedVersion.id),
        ).toBeUndefined();
        expect(await db.select().from(progress)).toEqual([
          {
            ...sourceProgress,
            itemId: destinationFile.itemId,
            versionId: null,
          },
        ]);

        const rescanned = await scanShowDirectory(db, library.id, "Foundation");
        expect(rescanned.itemId).toBe(showRoot.id);
        expect(await db.select().from(files)).toEqual(afterFiles);
      });
    }));

  test("a move into an absent Episode preserves the source Item and its state", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const foundationDir = join(root, "Foundation", "Season 01");
        const severanceDir = join(root, "Severance", "Season 01");
        await mkdir(foundationDir, { recursive: true });
        await mkdir(severanceDir, { recursive: true });
        const siblingPath = "Foundation/Season 01/Foundation S01E02.mkv";
        const destinationPath = "Foundation/Season 01/Foundation S01E01.mkv";
        const sourcePath = "Severance/Season 01/Severance S01E01.mkv";
        await createVideoFixture(join(root, siblingPath));
        await createVideoFixture(join(root, sourcePath));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        await scanShowDirectory(db, library.id, "Severance");

        const [siblingFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, siblingPath));
        const [sourceFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, sourcePath));
        if (!siblingFile || !sourceFile) {
          throw new Error("Initial scan produced no Episode Files.");
        }
        const sourceEpisodeId = sourceFile.itemId;
        const beforeItems = await db.select().from(items);
        const showRoot = beforeItems.find(
          (row) => row.kind === "show" && row.canonicalFolder === "Foundation",
        );
        const season = beforeItems.find(
          (row) =>
            row.kind === "season" &&
            row.canonicalFolder === "Foundation/Season 01",
        );
        const severanceContainers = beforeItems
          .filter(
            (row) =>
              row.kind !== "episode" &&
              row.canonicalFolder.startsWith("Severance"),
          )
          .map((row) => row.id);
        if (!showRoot || !season || severanceContainers.length === 0) {
          throw new Error("Initial scan produced no Show hierarchies.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db
          .update(items)
          .set({
            title: "Curated Severance Episode",
            year: 2022,
            overview: "A curated overview.",
            metadataState: "matched",
          })
          .where(eq(items.id, sourceEpisodeId));
        const [favourite] = await db
          .insert(favourites)
          .values({ userId: admin.id, itemId: sourceEpisodeId })
          .returning();
        const [rating] = await db
          .insert(ratings)
          .values({
            userId: admin.id,
            itemId: sourceEpisodeId,
            value: "8.5",
          })
          .returning();
        const [poster] = await db
          .insert(artwork)
          .values({
            itemId: sourceEpisodeId,
            versionId: null,
            type: "poster",
            backend: "configured-path",
            storageKey: "posters/severance-e01.jpg",
            sourceUrl: "https://image.example/poster.png",
            selected: true,
          })
          .returning();
        if (!favourite || !rating || !poster) {
          throw new Error("Item state fixture missing.");
        }
        const beforeItem = beforeItems.find(
          (row) => row.id === sourceEpisodeId,
        );
        if (!beforeItem) throw new Error("Source Episode missing.");

        await rename(join(root, sourcePath), join(root, destinationPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: destinationPath,
            previousPath: sourcePath,
            providerIds: {},
          },
        ]);

        const itemRows = await db.select().from(items);
        const preserved = itemRows.find((row) => row.id === sourceEpisodeId);
        expect(preserved).toMatchObject({
          parentId: season.id,
          canonicalFolder: "Foundation/Season 01",
          title: "Curated Severance Episode",
          year: 2022,
          overview: "A curated overview.",
          metadataState: "matched",
        });
        expect(
          severanceContainers.filter(
            (id) => itemRows.find((row) => row.id === id) !== undefined,
          ),
        ).toEqual([]);
        expect(itemRows.find((row) => row.id === showRoot.id)).toBeDefined();
        expect(itemRows.find((row) => row.id === season.id)).toBeDefined();
        expect(
          itemRows.find((row) => row.id === siblingFile.itemId),
        ).toBeDefined();
        const [episodeRow] = await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, sourceEpisodeId));
        expect(episodeRow).toMatchObject({
          seasonId: season.id,
          episodeNumber: 1,
          episodeEndNumber: null,
        });
        expect(await db.select().from(favourites)).toEqual([favourite]);
        expect(await db.select().from(ratings)).toEqual([rating]);
        expect(await db.select().from(artwork)).toEqual([poster]);
        const afterFiles = await db.select().from(files);
        expect(
          afterFiles.find((row) => row.path === destinationPath),
        ).toMatchObject({
          id: sourceFile.id,
          versionId: sourceFile.versionId,
          itemId: sourceEpisodeId,
        });
        expect(
          afterFiles.find((row) => row.path === siblingPath),
        ).toMatchObject({
          id: siblingFile.id,
          versionId: siblingFile.versionId,
          itemId: siblingFile.itemId,
        });
        expect(
          (
            await db
              .select({ itemId: versions.itemId })
              .from(versions)
              .where(eq(versions.id, sourceFile.versionId))
          )[0]?.itemId,
        ).toBe(sourceEpisodeId);

        const rescanned = await scanShowDirectory(db, library.id, "Foundation");
        expect(rescanned.itemId).toBe(showRoot.id);
        expect(await db.select().from(files)).toEqual(afterFiles);
        const rescanItems = await db.select().from(items);
        expect(rescanItems.map((row) => row.id).sort()).toEqual(
          itemRows.map((row) => row.id).sort(),
        );
      });
    }));

  test("a move into a Season with a different existing number lands atomically", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const foundationDir = join(root, "Foundation", "Season 01");
        const severanceDir = join(root, "Severance", "Season 01");
        await mkdir(foundationDir, { recursive: true });
        await mkdir(severanceDir, { recursive: true });
        const occupiedPath = "Foundation/Season 01/Foundation S01E01.mkv";
        const destinationPath = "Foundation/Season 01/Foundation S01E02.mkv";
        const sourcePath = "Severance/Season 01/Severance S01E01.mkv";
        await createVideoFixture(join(root, occupiedPath));
        await createVideoFixture(join(root, sourcePath));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        await scanShowDirectory(db, library.id, "Severance");
        const [occupiedFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, occupiedPath));
        const [sourceFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, sourcePath));
        if (!occupiedFile || !sourceFile) {
          throw new Error("Initial scan produced no Episode Files.");
        }
        const season = (await db.select().from(items)).find(
          (row) =>
            row.kind === "season" &&
            row.canonicalFolder === "Foundation/Season 01",
        );
        if (!season) throw new Error("Foundation Season missing.");

        await rename(join(root, sourcePath), join(root, destinationPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: destinationPath,
            previousPath: sourcePath,
            providerIds: {},
          },
        ]);

        const [episodeRow] = await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, sourceFile.itemId));
        expect(episodeRow).toMatchObject({
          seasonId: season.id,
          episodeNumber: 2,
          episodeEndNumber: null,
        });
        const [occupiedRow] = await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, occupiedFile.itemId));
        expect(occupiedRow).toMatchObject({
          seasonId: season.id,
          episodeNumber: 1,
        });
        const itemRows = await db.select().from(items);
        expect(
          itemRows.find((row) => row.id === sourceFile.itemId),
        ).toMatchObject({
          parentId: season.id,
          canonicalFolder: "Foundation/Season 01",
        });
        expect(
          (await db.select().from(files)).find(
            (row) => row.path === destinationPath,
          ),
        ).toMatchObject({ id: sourceFile.id, itemId: sourceFile.itemId });

        const rescanned = await scanShowDirectory(db, library.id, "Foundation");
        expect(rescanned.versionIds).toHaveLength(2);
      });
    }));

  test("a moved ranged Episode clamps before a persisted blocker", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const foundationDir = join(root, "Foundation", "Season 01");
        const severanceDir = join(root, "Severance", "Season 01");
        await mkdir(foundationDir, { recursive: true });
        await mkdir(severanceDir, { recursive: true });
        const blockerPath = "Foundation/Season 01/Foundation S01E02.mkv";
        const destinationPath =
          "Foundation/Season 01/Foundation S01E01-E03.mkv";
        const sourcePath = "Severance/Season 01/Severance S01E01-E03.mkv";
        await createVideoFixture(join(root, blockerPath));
        await createVideoFixture(join(root, sourcePath));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        await scanShowDirectory(db, library.id, "Severance");
        const [blockerFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, blockerPath));
        const [sourceFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, sourcePath));
        if (!blockerFile || !sourceFile) {
          throw new Error("Initial scan produced no Episode Files.");
        }
        const beforeBlocker = await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, blockerFile.itemId));
        expect(beforeBlocker[0]?.episodeNumber).toBe(2);

        await rename(join(root, sourcePath), join(root, destinationPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: destinationPath,
            previousPath: sourcePath,
            providerIds: {},
          },
        ]);

        const [episodeRow] = await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, sourceFile.itemId));
        expect(episodeRow).toMatchObject({
          episodeNumber: 1,
          episodeEndNumber: null,
        });
        expect(
          await db
            .select()
            .from(episodes)
            .where(eq(episodes.itemId, blockerFile.itemId)),
        ).toEqual(beforeBlocker);
        const [itemRow] = await db
          .select()
          .from(items)
          .where(eq(items.id, sourceFile.itemId));
        expect(itemRow?.canonicalFolder).toBe("Foundation/Season 01");

        await scanShowDirectory(db, library.id, "Foundation");
        const [rescanRow] = await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, sourceFile.itemId));
        expect(rescanRow).toMatchObject({
          episodeNumber: 1,
          episodeEndNumber: null,
        });
      });
    }));

  test("two source Episodes merge into one absent destination Episode", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const destinationDir = join(root, "Foundation", "Season 01");
        const severanceDir = join(root, "Severance", "Season 01");
        const darkDir = join(root, "Dark", "Season 01");
        await mkdir(destinationDir, { recursive: true });
        await mkdir(severanceDir, { recursive: true });
        await mkdir(darkDir, { recursive: true });
        await createVideoFixture(join(destinationDir, "Foundation S01E02.mkv"));
        const pathA = "Severance/Season 01/Severance S01E01.mkv";
        const pathB = "Dark/Season 01/Dark S01E01.mkv";
        const movedA = "Foundation/Season 01/Foundation S01E01.mkv";
        const movedB = "Foundation/Season 01/Foundation S01E01 - Alt.mkv";
        await createVideoFixture(join(root, pathA));
        await createVideoFixture(join(root, pathB));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        await scanShowDirectory(db, library.id, "Severance");
        await scanShowDirectory(db, library.id, "Dark");
        const [fileA] = await db
          .select()
          .from(files)
          .where(eq(files.path, pathA));
        const [fileB] = await db
          .select()
          .from(files)
          .where(eq(files.path, pathB));
        if (!fileA || !fileB) {
          throw new Error("Initial scans produced no Episode Files.");
        }
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const [progressA] = await db
          .insert(progress)
          .values({
            userId: admin.id,
            itemId: fileA.itemId,
            versionId: fileA.versionId,
            format: "video",
            positionSeconds: 30,
            updatedAt: new Date("2024-01-01T00:00:00Z"),
          })
          .returning();
        const [progressB] = await db
          .insert(progress)
          .values({
            userId: admin.id,
            itemId: fileB.itemId,
            versionId: fileB.versionId,
            format: "video",
            positionSeconds: 10,
            updatedAt: new Date("2020-01-01T00:00:00Z"),
          })
          .returning();
        if (!progressA || !progressB) {
          throw new Error("Progress fixture missing.");
        }

        await rename(join(root, pathA), join(root, movedA));
        await rename(join(root, pathB), join(root, movedB));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: movedA,
            previousPath: pathA,
            providerIds: {},
          },
          {
            kind: "move",
            path: movedB,
            previousPath: pathB,
            providerIds: {},
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(
          itemRows.filter(
            (row) =>
              row.canonicalFolder.startsWith("Severance") ||
              row.canonicalFolder.startsWith("Dark"),
          ),
        ).toEqual([]);
        const destinationEpisodes = itemRows.filter(
          (row) =>
            row.kind === "episode" &&
            row.canonicalFolder === "Foundation/Season 01",
        );
        expect(destinationEpisodes).toHaveLength(2);
        const mergedRows = await db
          .select({ itemId: episodes.itemId })
          .from(episodes)
          .innerJoin(items, eq(items.id, episodes.itemId))
          .where(
            and(
              eq(items.canonicalFolder, "Foundation/Season 01"),
              eq(episodes.episodeNumber, 1),
            ),
          );
        const mergedEpisodeId = mergedRows[0]?.itemId;
        expect(mergedRows).toHaveLength(1);
        if (!mergedEpisodeId) throw new Error("Destination Episode missing.");
        const afterFiles = await db.select().from(files);
        expect(
          afterFiles
            .filter((row) => row.itemId === mergedEpisodeId)
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toMatchObject([
          { id: fileB.id, versionId: fileB.versionId, path: movedB },
          { id: fileA.id, versionId: fileA.versionId, path: movedA },
        ]);
        const afterVersions = await db.select().from(versions);
        expect(
          afterVersions
            .filter((row) => row.itemId === mergedEpisodeId)
            .map((row) => row.id)
            .sort(),
        ).toEqual([fileA.versionId, fileB.versionId].sort());
        expect(await db.select().from(progress)).toEqual([
          { ...progressA, itemId: mergedEpisodeId },
        ]);

        const rescanned = await scanShowDirectory(db, library.id, "Foundation");
        expect(rescanned.versionIds).toHaveLength(3);
        expect(
          (await db.select().from(files)).map((row) => row.id).sort(),
        ).toEqual(afterFiles.map((row) => row.id).sort());
      });
    }));

  test("a stale indexed File blocks provider-id relocation", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const folderA = "Alien (1979) {tmdb-550}";
        const folderB = "Alien Remake (1979) {tmdb-550}";
        await mkdir(join(root, folderA));
        const fileA = `${folderA}/Alien.mkv`;
        await createVideoFixture(join(root, fileA));
        const library = await insertLibrary(db, root);
        const first = await scanDirectory(db, library.id, folderA);
        if (!first.itemId) throw new Error("Scan produced no Item.");
        const [indexedFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, fileA));
        if (!indexedFile) throw new Error("Indexed File missing.");

        // The media left out-of-band: the indexed row stays stale.
        await rm(join(root, folderA), { recursive: true });
        await mkdir(join(root, folderB));
        await createVideoFixture(join(root, `${folderB}/Alien Remake.mkv`));

        await expectAuthError(runScanJob(db, library.id, folderB), "CONFLICT");
        const [item] = await db.select().from(items);
        expect(item).toMatchObject({
          id: first.itemId,
          canonicalFolder: folderA,
        });
        expect(await db.select().from(files)).toMatchObject([
          { id: indexedFile.id, path: fileA, itemId: first.itemId },
        ]);
      });
    }));

  test("a stale indexed descendant File blocks Show provider-id relocation", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const showA = "Foundation";
        const showB = "Foundation Remake";
        const seasonA = join(root, showA, "Season 01");
        const seasonB = join(root, showB, "Season 01");
        await mkdir(seasonA, { recursive: true });
        const fileA = `${showA}/Season 01/${showA} S01E01.mkv`;
        await createVideoFixture(join(root, fileA));
        const library = await insertLibrary(db, root, "shows");
        const first = await scanShowDirectory(db, library.id, showA);
        if (!first.itemId) throw new Error("Scan produced no Show.");
        await setItemProviderIds(db, first.itemId, { tmdb: "550" });
        const [indexedFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, fileA));
        if (!indexedFile) throw new Error("Indexed File missing.");

        // The media left out-of-band: the descendant File row stays stale.
        await rm(join(root, showA), { recursive: true });
        await mkdir(seasonB, { recursive: true });
        await createVideoFixture(
          join(root, `${showB}/Season 01/${showB} S01E01.mkv`),
        );

        await expectAuthError(
          runScanJob(db, library.id, showB, [
            {
              kind: "add",
              path: `${showB}/Season 01/${showB} S01E01.mkv`,
              providerIds: { tmdb: "550" },
            },
          ]),
          "CONFLICT",
        );
        const itemRows = await db.select().from(items);
        const showRow = itemRows.find((row) => row.kind === "show");
        expect(showRow).toMatchObject({
          id: first.itemId,
          canonicalFolder: showA,
        });
        expect(itemRows.map((row) => row.canonicalFolder).sort()).toEqual(
          [showA, `${showA}/Season 01`, `${showA}/Season 01`].sort(),
        );
        expect(await db.select().from(files)).toMatchObject([
          {
            id: indexedFile.id,
            path: fileA,
            itemId: indexedFile.itemId,
          },
        ]);
      });
    }));

  test("a same-Season rename renumbers the preserved Episode", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const seasonDir = join(root, "Foundation", "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const firstPath = "Foundation/Season 01/Foundation S01E01.mkv";
        const secondPath = "Foundation/Season 01/Foundation S01E02.mkv";
        await createVideoFixture(join(root, firstPath));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        const [sourceFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, firstPath));
        if (!sourceFile) throw new Error("Scan produced no File.");
        const episodeItemId = sourceFile.itemId;

        // The complete File moves to a vacant number in the same Season.
        await rename(join(root, firstPath), join(root, secondPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: secondPath,
            previousPath: firstPath,
            providerIds: {},
          },
        ]);

        const [episodeRow] = await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, episodeItemId));
        expect(episodeRow).toMatchObject({ episodeNumber: 2 });
        expect(await db.select().from(files)).toMatchObject([
          {
            id: sourceFile.id,
            itemId: episodeItemId,
            versionId: sourceFile.versionId,
            path: secondPath,
          },
        ]);

        await scanShowDirectory(db, library.id, "Foundation");
        expect(await db.select().from(episodes)).toMatchObject([
          { itemId: episodeItemId, episodeNumber: 2 },
        ]);
        expect(await db.select().from(files)).toHaveLength(1);
      });
    }));

  test("an emptied source Episode merges its Item state into the destination", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const foundationDir = join(root, "Foundation", "Season 01");
        const severanceDir = join(root, "Severance", "Season 01");
        await mkdir(foundationDir, { recursive: true });
        await mkdir(severanceDir, { recursive: true });
        const destinationPath = "Foundation/Season 01/Foundation S01E01.mkv";
        const sourcePath = "Severance/Season 01/Severance S01E01.mkv";
        const mergedPath = "Foundation/Season 01/Foundation S01E01 - Alt.mkv";
        await createVideoFixture(join(root, destinationPath));
        await createVideoFixture(join(root, sourcePath));
        const library = await insertLibrary(db, root, "shows");
        await scanShowDirectory(db, library.id, "Foundation");
        await scanShowDirectory(db, library.id, "Severance");
        const [destinationFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, destinationPath));
        const [sourceFile] = await db
          .select()
          .from(files)
          .where(eq(files.path, sourcePath));
        if (!destinationFile || !sourceFile) {
          throw new Error("Initial scans produced no Episode Files.");
        }
        const destinationId = destinationFile.itemId;
        const sourceId = sourceFile.itemId;
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const viewer = await createLocalUser(db, admin.id, {
          username: "viewer",
          password: "viewer-pass",
        });
        // The source Item is the descriptive metadata winner.
        await db
          .update(items)
          .set({
            title: "Source Title",
            overview: "Source overview.",
            contentRating: "TV-MA",
            genres: ["Drama"],
            tags: ["curated"],
            metadataState: "matched",
            updatedAt: new Date("2024-01-01T00:00:00Z"),
          })
          .where(eq(items.id, sourceId));
        await db
          .update(items)
          .set({
            title: "Destination Title",
            metadataState: "unmatched",
            updatedAt: new Date("2020-01-01T00:00:00Z"),
          })
          .where(eq(items.id, destinationId));
        const [duplicateFavourite] = await db
          .insert(favourites)
          .values({ userId: admin.id, itemId: sourceId })
          .returning();
        const [destinationFavourite] = await db
          .insert(favourites)
          .values({ userId: admin.id, itemId: destinationId })
          .returning();
        const [movedFavourite] = await db
          .insert(favourites)
          .values({ userId: viewer.id, itemId: sourceId })
          .returning();
        const [winningRating] = await db
          .insert(ratings)
          .values({
            userId: admin.id,
            itemId: sourceId,
            value: "8.5",
            updatedAt: new Date("2024-06-01T00:00:00Z"),
          })
          .returning();
        await db.insert(ratings).values({
          userId: admin.id,
          itemId: destinationId,
          value: "5.0",
          updatedAt: new Date("2020-06-01T00:00:00Z"),
        });
        const [movedRating] = await db
          .insert(ratings)
          .values({
            userId: viewer.id,
            itemId: sourceId,
            value: "7.0",
          })
          .returning();
        const [explicitSourceId] = await db
          .insert(providerIds)
          .values({
            provider: "tmdb",
            value: "550",
            itemId: sourceId,
            metadataDerived: false,
          })
          .returning();
        const [derivedSourceImdb] = await db
          .insert(providerIds)
          .values({
            provider: "imdb",
            value: "tt-source",
            itemId: sourceId,
            metadataDerived: true,
          })
          .returning();
        await db.insert(providerIds).values({
          provider: "tmdb",
          value: "999",
          itemId: destinationId,
          metadataDerived: true,
        });
        const [destinationTvdb] = await db
          .insert(providerIds)
          .values({
            provider: "tvdb",
            value: "42",
            itemId: destinationId,
            metadataDerived: true,
          })
          .returning();
        const [nolan] = await db
          .insert(contributors)
          .values({ name: "Nolan" })
          .returning();
        const [hitchcock] = await db
          .insert(contributors)
          .values({ name: "Hitchcock" })
          .returning();
        if (!nolan || !hitchcock) throw new Error("Contributors missing.");
        await db.insert(credits).values({
          itemId: destinationId,
          contributorId: nolan.id,
          role: "director",
          order: 0,
        });
        await db.insert(credits).values({
          itemId: sourceId,
          contributorId: hitchcock.id,
          role: "director",
          order: 0,
        });
        const [destinationPoster] = await db
          .insert(artwork)
          .values({
            itemId: destinationId,
            type: "poster",
            backend: "configured-path",
            storageKey: "posters/dest.jpg",
            selected: true,
          })
          .returning();
        const [sourcePoster] = await db
          .insert(artwork)
          .values({
            itemId: sourceId,
            type: "poster",
            backend: "configured-path",
            storageKey: "posters/src.jpg",
            selected: true,
          })
          .returning();
        const [sourceLogo] = await db
          .insert(artwork)
          .values({
            itemId: sourceId,
            type: "logo",
            backend: "configured-path",
            storageKey: "logos/src.jpg",
            selected: true,
          })
          .returning();
        if (
          !duplicateFavourite ||
          !destinationFavourite ||
          !movedFavourite ||
          !winningRating ||
          !movedRating ||
          !explicitSourceId ||
          !derivedSourceImdb ||
          !destinationTvdb ||
          !destinationPoster ||
          !sourcePoster ||
          !sourceLogo
        ) {
          throw new Error("Item state fixture missing.");
        }

        await rename(join(root, sourcePath), join(root, mergedPath));
        await runScanJob(db, library.id, "Foundation", [
          {
            kind: "move",
            path: mergedPath,
            previousPath: sourcePath,
            providerIds: {},
          },
        ]);

        const itemRows = await db.select().from(items);
        expect(itemRows.find((row) => row.id === sourceId)).toBeUndefined();
        expect(
          itemRows.filter((row) => row.canonicalFolder.startsWith("Severance")),
        ).toEqual([]);
        const [destinationItem] = await db
          .select()
          .from(items)
          .where(eq(items.id, destinationId));
        // The descriptive winner's fields land on the surviving Item.
        expect(destinationItem).toMatchObject({
          id: destinationId,
          title: "Source Title",
          overview: "Source overview.",
          contentRating: "TV-MA",
          genres: ["Drama"],
          tags: ["curated"],
          metadataState: "matched",
          canonicalFolder: "Foundation/Season 01",
        });
        expect(
          (await db.select().from(favourites)).map((row) => row.id).sort(),
        ).toEqual([destinationFavourite.id, movedFavourite.id].sort());
        expect(
          (await db.select().from(ratings)).map((row) => row.id).sort(),
        ).toEqual([winningRating.id, movedRating.id].sort());
        const storedIds = await db
          .select()
          .from(providerIds)
          .where(eq(providerIds.itemId, destinationId));
        expect(
          storedIds
            .map((row) => [row.provider, row.value, row.metadataDerived])
            .sort(),
        ).toEqual([
          ["imdb", "tt-source", true],
          ["tmdb", "550", false],
          ["tvdb", "42", true],
        ]);
        expect(storedIds.map((row) => row.id).sort()).toEqual(
          [
            explicitSourceId.id,
            derivedSourceImdb.id,
            destinationTvdb.id,
          ].sort(),
        );
        expect(await db.select().from(credits)).toMatchObject([
          { itemId: destinationId, contributorId: hitchcock.id },
        ]);
        expect(
          (await db.select().from(artwork))
            .map((row) => [row.id, row.itemId, row.type, row.selected])
            .sort(),
        ).toEqual(
          [
            [destinationPoster.id, destinationId, "poster", false],
            [sourcePoster.id, destinationId, "poster", true],
            [sourceLogo.id, destinationId, "logo", true],
          ].sort(),
        );
        expect(
          (await db.select().from(files)).find(
            (row) => row.path === mergedPath,
          ),
        ).toMatchObject({
          id: sourceFile.id,
          itemId: destinationId,
          versionId: sourceFile.versionId,
        });
        expect(
          (await db.select().from(versions)).find(
            (row) => row.id === sourceFile.versionId,
          ),
        ).toMatchObject({ itemId: destinationId });
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
            runId: claimedRoot.id,
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
