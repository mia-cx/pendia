import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import {
  decodeCursor,
  defaultPageSize,
  maxPageSize,
  type PageKey,
  toPage,
} from "../api/pagination.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission, viewableLibraryIds } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  favourites,
  items,
  progress,
  ratings,
  versions,
} from "../db/schema/index.ts";

const cursorPrefix = "cw1.";

const instantText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function viewableItem(db: Database, userId: string, itemId: string) {
  const [item] = await db
    .select({ libraryId: items.libraryId })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (item === undefined) throw new AuthError("NOT_FOUND");
  await requirePermission(db, userId, "view", item.libraryId);
}

/** Reads the caller's favourite flag and rating for an Item. */
export async function getItemMarks(
  db: Database,
  userId: string,
  itemId: string,
) {
  await viewableItem(db, userId, itemId);
  const [favourite] = await db
    .select({ id: favourites.id })
    .from(favourites)
    .where(and(eq(favourites.userId, userId), eq(favourites.itemId, itemId)))
    .limit(1);
  const [rating] = await db
    .select({ value: ratings.value })
    .from(ratings)
    .where(and(eq(ratings.userId, userId), eq(ratings.itemId, itemId)))
    .limit(1);
  return {
    favourite: favourite !== undefined,
    rating: rating === undefined ? null : Number(rating.value),
  };
}

/** Sets or clears the caller's favourite flag on an Item. */
export async function setFavourite(
  db: Database,
  userId: string,
  itemId: string,
  favourite: boolean,
) {
  await viewableItem(db, userId, itemId);
  if (favourite) {
    await db
      .insert(favourites)
      .values({ userId, itemId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(favourites)
      .where(and(eq(favourites.userId, userId), eq(favourites.itemId, itemId)));
  }
  return getItemMarks(db, userId, itemId);
}

/** Sets or clears the caller's zero-to-ten, single-decimal rating on an Item. */
export async function setRating(
  db: Database,
  userId: string,
  itemId: string,
  rating: number | null,
) {
  await viewableItem(db, userId, itemId);
  const pair = and(eq(ratings.userId, userId), eq(ratings.itemId, itemId));
  if (rating === null) {
    await db.delete(ratings).where(pair);
  } else {
    if (
      !Number.isFinite(rating) ||
      rating < 0 ||
      rating > 10 ||
      Math.round(rating * 10) / 10 !== rating
    )
      throw new AuthError("INVALID_INPUT");
    await db
      .insert(ratings)
      .values({
        userId,
        itemId,
        value: rating.toFixed(1),
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: [ratings.userId, ratings.itemId],
        set: {
          value: rating.toFixed(1),
          updatedAt: sql`clock_timestamp()`,
        },
      });
  }
  return getItemMarks(db, userId, itemId);
}

/** Lists in-progress Items newest activity first, keyset-paginated by `cw1.` cursors. */
export async function continueWatching(
  db: Database,
  userId: string,
  input: { limit?: number; cursor?: string },
) {
  const limit = input.limit ?? defaultPageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxPageSize)
    throw new AuthError("INVALID_INPUT");
  let key: PageKey | undefined;
  if (input.cursor !== undefined) {
    if (!input.cursor.startsWith(cursorPrefix))
      throw new AuthError("INVALID_INPUT");
    key = decodeCursor(input.cursor.slice(cursorPrefix.length));
    if (key === undefined) throw new AuthError("INVALID_INPUT");
  }
  const viewable = await viewableLibraryIds(db, userId);
  if (viewable.length === 0) return { items: [], cursor: null };
  const rows = await db
    .select({
      item: {
        id: items.id,
        kind: items.kind,
        libraryId: items.libraryId,
        title: items.title,
        year: items.year,
        addedAt: instantText(items.addedAt),
        posterArtworkId: sql<string | null>`(
          select ${artwork.id}
          from ${artwork}
          where ${artwork.itemId} = "items"."id"
            and ${artwork.type} = 'poster'
            and ${artwork.selected} = true
          limit 1
        )`,
      },
      progress: {
        userId: progress.userId,
        itemId: progress.itemId,
        versionId: progress.versionId,
        format: progress.format,
        positionSeconds: progress.positionSeconds,
        completed: progress.completed,
        playedAt: instantText(progress.playedAt),
        playCount: progress.playCount,
        updatedAt: instantText(progress.updatedAt),
      },
      durationSeconds: versions.durationSeconds,
    })
    .from(progress)
    .innerJoin(items, eq(items.id, progress.itemId))
    .leftJoin(versions, eq(versions.id, progress.versionId))
    .where(
      and(
        eq(progress.userId, userId),
        eq(progress.completed, false),
        gt(progress.positionSeconds, 0),
        isNotNull(progress.playedAt),
        inArray(items.libraryId, viewable),
        key === undefined
          ? undefined
          : sql`(${progress.playedAt}, ${items.id}) < (${key.addedAt}::timestamptz, ${key.id}::uuid)`,
      ),
    )
    .orderBy(desc(progress.playedAt), desc(items.id))
    .limit(limit + 1);
  const page = toPage(rows, limit, (row) => ({
    addedAt: row.progress.playedAt,
    id: row.item.id,
  }));
  return {
    items: page.items,
    cursor: page.cursor === null ? null : `${cursorPrefix}${page.cursor}`,
  };
}
