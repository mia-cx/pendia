import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  files,
  items,
  libraries,
  providerIds as providerIdRows,
  type ScanChange,
  versions,
} from "../db/schema/index.ts";
import { type DeletedArtworkFile, deleteItemSubtree } from "../db/tree.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;

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

async function removeMoveCollision(
  db: Connection,
  survivor: typeof files.$inferSelect,
  displaced: typeof files.$inferSelect,
  deletedArtwork: DeletedArtworkFile[],
): Promise<void> {
  if (displaced.itemId === survivor.itemId) {
    const [destinationSibling] = await db
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.versionId, displaced.versionId),
          ne(files.id, displaced.id),
        ),
      )
      .limit(1);
    if (destinationSibling === undefined) {
      await db.delete(versions).where(eq(versions.id, displaced.versionId));
    } else {
      await db.delete(files).where(eq(files.id, displaced.id));
    }
    return;
  }
  const [displacedItem] = await db
    .select({ parentId: items.parentId })
    .from(items)
    .where(eq(items.id, displaced.itemId));
  await deleteItemSubtree(db, displaced.itemId, deletedArtwork);
  // Prune only emptied containers; a populated Season or Show stays.
  let ancestorId = displacedItem?.parentId ?? null;
  while (ancestorId !== null) {
    const [ancestor] = await db
      .select({ parentId: items.parentId })
      .from(items)
      .where(eq(items.id, ancestorId));
    if (!ancestor) break;
    const [child] = await db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.parentId, ancestorId))
      .limit(1);
    if (child !== undefined) break;
    await deleteItemSubtree(db, ancestorId, deletedArtwork);
    ancestorId = ancestor.parentId;
  }
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
  // Classify genuine cycle sources. A one-to-one mapping makes each walk
  // terminate, and every node on a cycle discovers itself on its own walk.
  const cycleMoveSources = new Set<string>();
  for (const source of moveDestinationsBySource.keys()) {
    const seen = new Set([source]);
    let current = moveDestinationsBySource.get(source);
    while (current !== undefined) {
      if (current === source) {
        cycleMoveSources.add(source);
        break;
      }
      if (seen.has(current)) break;
      seen.add(current);
      current = moveDestinationsBySource.get(current);
    }
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
  // Consumed originals stay identifiable so a repeated event for an already
  // moved row can displace whichever produced row now occupies its source.
  const consumedMoveSources = new Map<string, typeof files.$inferSelect>();
  const firstMoveSource = normalized.find(
    (entry) => entry.change.kind === "move",
  )?.previousPath;
  for (const { change, path, previousPath } of normalized) {
    if (change.kind === "add") continue;
    if (change.kind === "move") {
      if (previousPath === undefined) throw new AuthError("INVALID_INPUT");
      const producedAtSource = producedMoves.get(previousPath);
      const parkedOriginal = moveSources.get(previousPath);
      let file: typeof files.$inferSelect | undefined;
      if (
        parkedOriginal !== undefined &&
        producedAtSource !== undefined &&
        producedAtSource.id !== parkedOriginal.id
      ) {
        moveSources.delete(previousPath);
        if (cycleMoveSources.has(previousPath)) {
          // Simultaneous cycle: the parked original still owns this move.
          consumedMoveSources.set(previousPath, parkedOriginal);
          file = parkedOriginal;
        } else {
          // Ordered overwrite: the produced row holds the surviving bytes and
          // the parked original was overwritten.
          await removeMoveCollision(
            db,
            producedAtSource,
            parkedOriginal,
            deletedArtwork,
          );
          producedMoves.delete(previousPath);
          file = producedAtSource;
        }
      } else if (parkedOriginal !== undefined) {
        moveSources.delete(previousPath);
        consumedMoveSources.set(previousPath, parkedOriginal);
        file = parkedOriginal;
      }
      if (file === undefined) {
        const consumedOriginal = consumedMoveSources.get(previousPath);
        if (consumedOriginal !== undefined) {
          const [currentConsumed] = await db
            .select({ path: files.path })
            .from(files)
            .where(eq(files.id, consumedOriginal.id));
          if (currentConsumed === undefined) continue;
          if (currentConsumed.path === path) {
            const producedRow = producedMoves.get(previousPath);
            if (
              producedRow === undefined ||
              producedRow.id === consumedOriginal.id
            ) {
              continue;
            }
            if (previousPath === firstMoveSource) {
              await removeMoveCollision(
                db,
                consumedOriginal,
                producedRow,
                deletedArtwork,
              );
              producedMoves.delete(previousPath);
              continue;
            }
            // A repeated reverse event for a later source: the produced row
            // carries the first surviving identity and the consumed original
            // at the destination is stale.
            await removeMoveCollision(
              db,
              producedRow,
              consumedOriginal,
              deletedArtwork,
            );
            consumedMoveSources.delete(previousPath);
            producedMoves.delete(previousPath);
            file = producedRow;
          } else if (currentConsumed.path !== previousPath) {
            continue;
          }
          if (file === undefined) {
            // The original row moved back to this source path; resolve it
            // through producedMoves like any other pending move.
            file = producedMoves.get(previousPath);
            if (file !== undefined) producedMoves.delete(previousPath);
          }
        } else {
          file = producedMoves.get(previousPath);
          if (file !== undefined) producedMoves.delete(previousPath);
        }
      }
      const [destination] = await db
        .select()
        .from(files)
        .where(and(eq(files.libraryId, libraryId), eq(files.path, path)));
      if (file && destination) {
        if (file.id === destination.id) continue;
        await removeMoveCollision(db, file, destination, deletedArtwork);
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
