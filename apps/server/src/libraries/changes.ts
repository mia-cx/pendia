import { posix } from "node:path";
import { and, eq, or, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  items,
  providerIds as providerIdRows,
  type ScanChange,
  versions,
} from "../db/schema/index.ts";
import { deleteItemSubtree } from "../db/tree.ts";

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

/** Applies queued moves and deletes before a directory scan writes its result. */
export async function applyScanChanges(
  db: Connection,
  libraryId: string,
  changes: readonly ScanChange[],
): Promise<void> {
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
      if (file) {
        await db.update(files).set({ path }).where(eq(files.id, file.id));
        const [item] = await db
          .select()
          .from(items)
          .where(eq(items.id, file.itemId));
        if (item && item.canonicalFolder === posix.dirname(previousPath)) {
          await db
            .update(items)
            .set({
              canonicalFolder: posix.dirname(path),
              updatedAt: new Date(),
            })
            .where(eq(items.id, item.id));
        }
        continue;
      }
      const item = await findItemByProviderIds(
        db,
        libraryId,
        change.providerIds,
      );
      if (item && item.canonicalFolder === posix.dirname(previousPath)) {
        await db
          .update(items)
          .set({ canonicalFolder: posix.dirname(path) })
          .where(eq(items.id, item.id));
      }
      continue;
    }
    if (change.target === "file") {
      const [file] = await db
        .select()
        .from(files)
        .where(and(eq(files.libraryId, libraryId), eq(files.path, path)));
      if (!file) continue;
      await db.delete(versions).where(eq(versions.id, file.versionId));
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
    if (item) await deleteItemSubtree(db, item.id);
  }
}
