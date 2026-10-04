import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  files,
  itemAncestors,
  items,
  libraries,
  providerIds as providerIdRows,
  type ScanChange,
  versions,
} from "../db/schema/index.ts";
import { type DeletedArtworkFile, deleteItemSubtree } from "../db/tree.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;

const rootItemId = async (db: Connection, itemId: string): Promise<string> => {
  const [root] = await db
    .select({ id: items.id })
    .from(itemAncestors)
    .innerJoin(items, eq(itemAncestors.ancestorId, items.id))
    .where(and(eq(itemAncestors.descendantId, itemId), eq(items.kind, "show")))
    .limit(1);
  return root?.id ?? itemId;
};

/** Reports whether a library-relative path lies in another Show or Movie than the given Item. */
export async function leavesRoot(
  db: Connection,
  libraryId: string,
  itemId: string,
  path: string,
): Promise<boolean> {
  const folders: string[] = [];
  for (
    let folder = posix.dirname(path);
    folder !== ".";
    folder = posix.dirname(folder)
  )
    folders.push(folder);
  if (folders.length === 0) return false;
  const [root] = await db
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.libraryId, libraryId),
        isNull(items.parentId),
        inArray(items.canonicalFolder, folders),
      ),
    )
    .orderBy(desc(sql`length(${items.canonicalFolder})`))
    .limit(1);
  return root !== undefined && root.id !== (await rootItemId(db, itemId));
}

/**
 * Reports whether a root holds only Files an early scan recorded from Files
 * this batch moves in: each sits at a move's destination with the size and
 * mtime of the File moving there, which a rename keeps.
 */
const isEarlyDuplicate = async (
  db: Connection,
  libraryId: string,
  rootId: string,
  movedFrom: ReadonlyMap<string, string>,
): Promise<boolean> => {
  const stamp = (file: { bytes: bigint; modifiedAt: Date }) =>
    `${file.bytes}:${file.modifiedAt.getTime()}`;
  const held = await db
    .select({
      path: files.path,
      bytes: files.bytes,
      modifiedAt: files.modifiedAt,
    })
    .from(files)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .where(eq(itemAncestors.ancestorId, rootId));
  const pairs: [string, string][] = [];
  for (const file of held) {
    const from = movedFrom.get(file.path);
    if (from === undefined) return false;
    pairs.push([from, stamp(file)]);
  }
  const sources = await db
    .select({
      path: files.path,
      bytes: files.bytes,
      modifiedAt: files.modifiedAt,
    })
    .from(files)
    .where(
      and(
        eq(files.libraryId, libraryId),
        inArray(
          files.path,
          pairs.map(([from]) => from),
        ),
      ),
    );
  const sourceStamps = new Map(sources.map((file) => [file.path, stamp(file)]));
  return pairs.every(([from, held]) => sourceStamps.get(from) === held);
};

/** Removes one File, or its Version when no other File remains, and returns the Item that may now be empty. */
const removeFile = async (
  db: Connection,
  file: typeof files.$inferSelect,
): Promise<string | undefined> => {
  const [sibling] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.versionId, file.versionId), ne(files.id, file.id)))
    .limit(1);
  if (sibling !== undefined) {
    await db.delete(files).where(eq(files.id, file.id));
    return undefined;
  }
  await db.delete(versions).where(eq(versions.id, file.versionId));
  return file.itemId;
};

const requireRelativePath = (path: string, allowDot: boolean): string => {
  if (
    path === "" ||
    path.includes("\0") ||
    posix.isAbsolute(path) ||
    path.split("/").includes("..")
  )
    throw new AuthError("INVALID_INPUT");
  const normalized = posix.normalize(path);
  if (normalized === "." && !allowDot) throw new AuthError("INVALID_INPUT");
  return normalized;
};

const providerIdPairs = (providerIds: Record<string, string>) =>
  Object.entries(providerIds).filter(
    ([provider, value]) => provider !== "" && value !== "",
  );

/** Finds one Item from a consistent set of explicit provider ids; ids a metadata provider derived never identify an Item. */
export async function findItemByProviderIds(
  db: Connection,
  libraryId: string,
  providerIds: Record<string, string>,
): Promise<typeof items.$inferSelect | undefined> {
  const pairs = providerIdPairs(providerIds);
  if (pairs.length === 0) return undefined;
  const rows = await db
    .select({ item: items })
    .from(providerIdRows)
    .innerJoin(items, eq(providerIdRows.itemId, items.id))
    .where(
      and(
        eq(items.libraryId, libraryId),
        eq(providerIdRows.metadataDerived, false),
        or(
          ...pairs.map(([provider, value]) =>
            and(
              eq(providerIdRows.provider, provider),
              eq(providerIdRows.value, value),
            ),
          ),
        ),
      ),
    );
  const matched = new Map(rows.map((row) => [row.item.id, row.item]));
  if (matched.size > 1) throw new AuthError("CONFLICT");
  return matched.values().next().value;
}

/**
 * Upserts explicit provider ids on one Item and reports whether any changed.
 * With `fillOnly`, an id already asserted explicitly keeps its value: folder
 * tags fill gaps but never undo a webhook's correction.
 */
export async function setItemProviderIds(
  db: Connection,
  itemId: string,
  providerIds: Record<string, string>,
  { fillOnly = false }: { fillOnly?: boolean } = {},
): Promise<boolean> {
  let changed = false;
  for (const [provider, value] of providerIdPairs(providerIds)) {
    const [existing] = await db
      .select({
        value: providerIdRows.value,
        metadataDerived: providerIdRows.metadataDerived,
      })
      .from(providerIdRows)
      .where(
        and(
          eq(providerIdRows.itemId, itemId),
          eq(providerIdRows.provider, provider),
        ),
      );
    // Scan input is explicit: an equal derived value still becomes owned.
    if (
      existing !== undefined &&
      !existing.metadataDerived &&
      (fillOnly || existing.value === value)
    )
      continue;
    await db
      .insert(providerIdRows)
      .values({ provider, value, itemId, metadataDerived: false })
      .onConflictDoUpdate({
        target: [providerIdRows.itemId, providerIdRows.provider],
        targetWhere: sql`${providerIdRows.itemId} is not null`,
        set: { value, metadataDerived: false },
      });
    changed = true;
  }
  return changed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Updates an Item folder and re-keys colocated artwork that moved with it. */
export async function updateItemCanonicalFolder(
  db: Connection,
  item: typeof items.$inferSelect,
  canonicalFolder: string,
): Promise<void> {
  if (item.canonicalFolder === canonicalFolder) return;
  const marker = "/.pendia/artwork/";
  const [library] = await db
    .select({ rootPath: libraries.rootPath })
    .from(libraries)
    .where(eq(libraries.id, item.libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  const rows = await db
    .select({ id: artwork.id, storageKey: artwork.storageKey })
    .from(artwork)
    .where(and(eq(artwork.itemId, item.id), eq(artwork.backend, "colocated")));
  for (const row of rows) {
    const index = row.storageKey.lastIndexOf(marker);
    if (index < 0) throw new Error("Invalid artwork storage key.");
    const nextStorageKey = `${canonicalFolder}${row.storageKey.slice(index)}`;
    if (
      (await pathExists(join(library.rootPath, nextStorageKey))) ||
      !(await pathExists(join(library.rootPath, row.storageKey)))
    ) {
      await db
        .update(artwork)
        .set({ storageKey: nextStorageKey })
        .where(eq(artwork.id, row.id));
    }
  }
  await db
    .update(items)
    .set({ canonicalFolder, updatedAt: new Date() })
    .where(eq(items.id, item.id));
}

/** Applies queued moves and deletes before a directory scan writes its result. */
export async function applyScanChanges(
  db: Connection,
  libraryId: string,
  changes: readonly ScanChange[],
  deletedArtwork: DeletedArtworkFile[] = [],
): Promise<string[]> {
  const normalized = changes.map((change) => ({
    change,
    path: requireRelativePath(
      change.path,
      change.kind === "delete" && change.target === "item",
    ),
    previousPath:
      change.kind === "move"
        ? requireRelativePath(change.previousPath, false)
        : undefined,
  }));
  const movedFrom = new Map(
    normalized.flatMap(({ path, previousPath }) =>
      previousPath === undefined ? [] : [[path, previousPath] as const],
    ),
  );
  const emptiedItemIds: string[] = [];
  for (const { change, path, previousPath } of normalized) {
    if (change.kind === "add") continue;
    if (change.kind === "move") {
      if (previousPath === undefined) throw new AuthError("INVALID_INPUT");
      const [file] = await db
        .select()
        .from(files)
        .where(
          and(eq(files.libraryId, libraryId), eq(files.path, previousPath)),
        );
      const [destination] = await db
        .select()
        .from(files)
        .where(and(eq(files.libraryId, libraryId), eq(files.path, path)));
      if (file && destination) {
        if (file.id === destination.id) continue;
        // A collision replaces only the colliding Item. The exception is a
        // duplicate root an early scan made of a moved folder.
        if (destination.itemId === file.itemId) {
          await db
            .delete(versions)
            .where(eq(versions.id, destination.versionId));
        } else {
          const destinationRootId = await rootItemId(db, destination.itemId);
          const duplicate =
            destinationRootId !== (await rootItemId(db, file.itemId)) &&
            (await isEarlyDuplicate(
              db,
              libraryId,
              destinationRootId,
              movedFrom,
            ));
          await deleteItemSubtree(
            db,
            duplicate ? destinationRootId : destination.itemId,
            deletedArtwork,
          );
        }
      }
      if (file) {
        // A move into another Show or Movie leaves its source, and the
        // destination folder's scan adds it there. Progress stays behind.
        if (await leavesRoot(db, libraryId, file.itemId, path)) {
          const emptied = await removeFile(db, file);
          if (emptied !== undefined) emptiedItemIds.push(emptied);
          continue;
        }
        await db.update(files).set({ path }).where(eq(files.id, file.id));
        const [item] = await db
          .select()
          .from(items)
          .where(eq(items.id, file.itemId));
        if (item && item.canonicalFolder === posix.dirname(previousPath)) {
          await updateItemCanonicalFolder(db, item, posix.dirname(path));
        }
        continue;
      }
      const item = await findItemByProviderIds(
        db,
        libraryId,
        change.providerIds,
      );
      if (item && item.canonicalFolder === posix.dirname(previousPath)) {
        await updateItemCanonicalFolder(db, item, posix.dirname(path));
      }
      continue;
    }
    if (change.target === "file") {
      const [file] = await db
        .select()
        .from(files)
        .where(and(eq(files.libraryId, libraryId), eq(files.path, path)));
      if (!file) continue;
      const emptied = await removeFile(db, file);
      if (emptied !== undefined) emptiedItemIds.push(emptied);
      continue;
    }
    let item = await findItemByProviderIds(db, libraryId, change.providerIds);
    if (!item) {
      const [byFolder] = await db
        .select()
        .from(items)
        .where(
          and(eq(items.libraryId, libraryId), eq(items.canonicalFolder, path)),
        );
      item = byFolder;
    }
    if (item) await deleteItemSubtree(db, item.id, deletedArtwork);
  }
  return [...new Set(emptiedItemIds)];
}
