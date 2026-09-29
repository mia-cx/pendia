import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { and, eq, ne, or, sql } from "drizzle-orm";
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

/** Finds one Item from a consistent set of provider ids. */
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

/** Upserts provider ids owned by one Item. */
export async function setItemProviderIds(
  db: Connection,
  itemId: string,
  providerIds: Record<string, string>,
): Promise<void> {
  for (const [provider, value] of providerIdPairs(providerIds)) {
    await db
      .insert(providerIdRows)
      .values({ provider, value, itemId })
      .onConflictDoUpdate({
        target: [providerIdRows.itemId, providerIdRows.provider],
        targetWhere: sql`${providerIdRows.itemId} is not null`,
        set: { value },
      });
  }
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
  const emptiedItemIds: string[] = [];
  // A batch of moves maps sources to destinations one-to-one. Exact repeats
  // process idempotently; conflicting mappings reject before any write.
  const moveDestinationsBySource = new Map<string, string>();
  const moveSourcesByDestination = new Map<string, string>();
  for (const { change, path, previousPath } of normalized) {
    if (change.kind !== "move" || previousPath === undefined) continue;
    const mappedDestination = moveDestinationsBySource.get(previousPath);
    if (mappedDestination !== undefined && mappedDestination !== path) {
      throw new AuthError("INVALID_INPUT");
    }
    const mappedSource = moveSourcesByDestination.get(path);
    if (mappedSource !== undefined && mappedSource !== previousPath) {
      throw new AuthError("INVALID_INPUT");
    }
    moveDestinationsBySource.set(previousPath, path);
    moveSourcesByDestination.set(path, previousPath);
  }
  // Snapshot every source row and park it at a transaction-local placeholder
  // so a later destination that is itself a source does not pick up the
  // mutated row.
  const moveSources = new Map<string, typeof files.$inferSelect>();
  for (const { change, previousPath } of normalized) {
    if (change.kind !== "move" || previousPath === undefined) continue;
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.libraryId, libraryId), eq(files.path, previousPath)));
    if (!file) continue;
    moveSources.set(previousPath, file);
    await db
      .update(files)
      .set({ path: `.pendia-move/${Bun.randomUUIDv7()}` })
      .where(eq(files.id, file.id));
  }
  // Ordered chains land an earlier move's row at a later move's source path.
  const producedMoves = new Map<string, typeof files.$inferSelect>();
  for (const { change, path, previousPath } of normalized) {
    if (change.kind === "add") continue;
    if (change.kind === "move") {
      if (previousPath === undefined) throw new AuthError("INVALID_INPUT");
      let file = moveSources.get(previousPath);
      if (file !== undefined) moveSources.delete(previousPath);
      if (file === undefined) {
        file = producedMoves.get(previousPath);
        if (file !== undefined) producedMoves.delete(previousPath);
      }
      const [destination] = await db
        .select()
        .from(files)
        .where(and(eq(files.libraryId, libraryId), eq(files.path, path)));
      if (file && destination) {
        if (file.id === destination.id) continue;
        if (destination.itemId === file.itemId) {
          const [destinationSibling] = await db
            .select({ id: files.id })
            .from(files)
            .where(
              and(
                eq(files.versionId, destination.versionId),
                ne(files.id, destination.id),
              ),
            )
            .limit(1);
          if (destinationSibling === undefined) {
            await db
              .delete(versions)
              .where(eq(versions.id, destination.versionId));
          } else {
            await db.delete(files).where(eq(files.id, destination.id));
          }
        } else {
          const sourceRootId = await rootItemId(db, file.itemId);
          const destinationRootId = await rootItemId(db, destination.itemId);
          await deleteItemSubtree(
            db,
            sourceRootId === destinationRootId
              ? destination.itemId
              : destinationRootId,
            deletedArtwork,
          );
        }
      }
      if (file) {
        await db.update(files).set({ path }).where(eq(files.id, file.id));
        producedMoves.set(path, file);
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
      const [sibling] = await db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.versionId, file.versionId), ne(files.id, file.id)))
        .limit(1);
      if (sibling === undefined) {
        emptiedItemIds.push(file.itemId);
        await db.delete(versions).where(eq(versions.id, file.versionId));
      } else {
        await db.delete(files).where(eq(files.id, file.id));
      }
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
