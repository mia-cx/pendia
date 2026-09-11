import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  episodes,
  itemAncestors,
  items,
  libraries,
  movies,
  seasons,
  shows,
} from "./schema/index.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;
type Item = typeof items.$inferInsert;
type Extension<T> = Omit<T, "itemId" | "kind" | "showId" | "seasonId">;
type NewItem = Omit<Item, "kind" | "parentId"> &
  (
    | {
        kind: "movie";
        parentId?: null;
        extension: Extension<typeof movies.$inferInsert>;
      }
    | {
        kind: "show";
        parentId?: null;
        extension: Extension<typeof shows.$inferInsert>;
      }
    | {
        kind: "season";
        parentId: string;
        extension: Extension<typeof seasons.$inferInsert>;
      }
    | {
        kind: "episode";
        parentId: string;
        extension: Extension<typeof episodes.$inferInsert>;
      }
  );

async function lockLibrary(tx: Transaction, libraryId: string) {
  const [library] = await tx
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId))
    .for("update");
  if (!library) throw new Error("Library not found.");
  return library;
}

async function getItem(tx: Transaction, itemId: string) {
  const [item] = await tx.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new Error("Item not found.");
  return item;
}

async function validateParent(
  tx: Transaction,
  item: Item,
  parentId: string | null,
  medium: typeof libraries.$inferSelect.medium,
) {
  if ((item.kind === "movie" ? "movies" : "shows") !== medium) {
    throw new Error("Item kind does not match the library medium.");
  }
  const parentKind = {
    movie: null,
    show: null,
    season: "show",
    episode: "season",
  }[item.kind];
  if (parentKind === null) {
    if (parentId !== null) throw new Error("Movies and shows must be roots.");
    return;
  }
  if (parentId === null) throw new Error("Seasons and episodes need a parent.");
  const parent = await getItem(tx, parentId);
  if (parent.libraryId !== item.libraryId || parent.kind !== parentKind) {
    throw new Error("Parent kind or library does not match the item.");
  }
}

/** Inserts an Item, its extension and ancestry atomically under the library lock. */
export async function insertItem(db: Connection, input: NewItem) {
  return db.transaction(async (tx) => {
    const library = await lockLibrary(tx, input.libraryId);
    await validateParent(tx, input, input.parentId ?? null, library.medium);
    const { extension: _extension, ...values } = input;
    const [item] = await tx.insert(items).values(values).returning();
    if (!item) throw new Error("Item insertion returned no row.");
    switch (input.kind) {
      case "movie":
        await tx.insert(movies).values({ ...input.extension, itemId: item.id });
        break;
      case "show":
        await tx.insert(shows).values({ ...input.extension, itemId: item.id });
        break;
      case "season":
        await tx.insert(seasons).values({
          ...input.extension,
          itemId: item.id,
          showId: input.parentId,
        });
        break;
      case "episode":
        await tx.insert(episodes).values({
          ...input.extension,
          itemId: item.id,
          seasonId: input.parentId,
        });
        break;
    }
    const ancestors =
      item.parentId === null
        ? []
        : await tx
            .select()
            .from(itemAncestors)
            .where(eq(itemAncestors.descendantId, item.parentId));
    await tx.insert(itemAncestors).values([
      { ancestorId: item.id, descendantId: item.id, depth: 0 },
      ...ancestors.map((ancestor) => ({
        ancestorId: ancestor.ancestorId,
        descendantId: item.id,
        depth: ancestor.depth + 1,
      })),
    ]);
    return item;
  });
}

/** Moves a subtree and its extension parent atomically within one library. */
export async function moveItem(
  db: Connection,
  itemId: string,
  parentId: string | null,
) {
  return db.transaction(async (tx) => {
    const original = await getItem(tx, itemId);
    const library = await lockLibrary(tx, original.libraryId);
    const item = await getItem(tx, itemId);
    if (parentId !== null) {
      const [cycle] = await tx
        .select()
        .from(itemAncestors)
        .where(
          and(
            eq(itemAncestors.ancestorId, itemId),
            eq(itemAncestors.descendantId, parentId),
          ),
        );
      if (cycle) throw new Error("Cannot move an item into its subtree.");
    }
    await validateParent(tx, item, parentId, library.medium);
    if (item.parentId === parentId) return item;

    // Keep internal ancestry and replace only paths entering the subtree.
    await tx.execute(sql`
      delete from item_ancestors
      where descendant_id in (select descendant_id from item_ancestors where ancestor_id = ${itemId})
      and ancestor_id not in (select descendant_id from item_ancestors where ancestor_id = ${itemId})
    `);
    if (parentId !== null) {
      const ancestors = await tx
        .select()
        .from(itemAncestors)
        .where(eq(itemAncestors.descendantId, parentId));
      const descendants = await tx
        .select()
        .from(itemAncestors)
        .where(eq(itemAncestors.ancestorId, itemId));
      await tx.insert(itemAncestors).values(
        ancestors.flatMap((ancestor) =>
          descendants.map((descendant) => ({
            ancestorId: ancestor.ancestorId,
            descendantId: descendant.descendantId,
            depth: ancestor.depth + descendant.depth + 1,
          })),
        ),
      );
      if (item.kind === "season")
        await tx
          .update(seasons)
          .set({ showId: parentId })
          .where(eq(seasons.itemId, itemId));
      if (item.kind === "episode")
        await tx
          .update(episodes)
          .set({ seasonId: parentId })
          .where(eq(episodes.itemId, itemId));
    }
    const [moved] = await tx
      .update(items)
      .set({ parentId, updatedAt: new Date() })
      .where(eq(items.id, itemId))
      .returning();
    return moved;
  });
}

/** Deletes an Item and its owned subtree without removing filesystem content. */
export async function deleteItemSubtree(db: Connection, itemId: string) {
  await db.transaction(async (tx) => {
    const item = await getItem(tx, itemId);
    await lockLibrary(tx, item.libraryId);
    await tx.delete(items).where(eq(items.id, itemId));
  });
}
