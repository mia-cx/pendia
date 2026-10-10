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
import { publishEvent } from "../api/events.ts";
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
  itemAncestors,
  items,
  progress,
  ratings,
  versions,
} from "../db/schema/index.ts";

const cursorPrefix = "cw1.";
type MarksDb = Pick<
  Database,
  | "select"
  | "selectDistinctOn"
  | "insert"
  | "delete"
  | "update"
  | "execute"
  | "transaction"
>;

const instantText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function viewableItem(db: MarksDb, userId: string, itemId: string) {
  const [item] = await db
    .select({ libraryId: items.libraryId })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (item === undefined) throw new AuthError("NOT_FOUND");
  await requirePermission(db, userId, "view", item.libraryId);
}

/** Reads the caller's favourite flag and numeric rating for an Item. */
export async function getItemMarks(
  db: MarksDb,
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
    rating: rating?.value == null ? null : Number(rating.value),
  };
}

/** Sets or clears the caller's favourite flag on an Item. */
export async function setFavourite(
  db: MarksDb,
  userId: string,
  itemId: string,
  favourite: boolean,
) {
  await viewableItem(db, userId, itemId);
  await db.transaction(async (tx) => {
    if (favourite) {
      await tx
        .insert(favourites)
        .values({ userId, itemId })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(favourites)
        .where(
          and(eq(favourites.userId, userId), eq(favourites.itemId, itemId)),
        );
    }
    await publishEvent(tx, {
      kind: "user-data.changed",
      userId,
      itemIds: [itemId],
    });
  });
  return getItemMarks(db, userId, itemId);
}

/**
 * Marks an Item and everything under it played or unplayed for the caller,
 * as marking a Show watched marks its Episodes. Played finishes each Item
 * that has a Version and counts a play; unplayed clears the progress of all.
 */
export async function setPlayed(
  db: MarksDb,
  userId: string,
  itemId: string,
  played: boolean,
  playedAt?: Date,
) {
  if (playedAt !== undefined && !Number.isFinite(playedAt.getTime()))
    throw new AuthError("INVALID_INPUT");
  await viewableItem(db, userId, itemId);
  const tree = (
    await db
      .select({ id: itemAncestors.descendantId })
      .from(itemAncestors)
      .where(eq(itemAncestors.ancestorId, itemId))
  ).map((row) => row.id);
  // Each Item's progress takes the format of its first Version.
  const targets = played
    ? await db
        .selectDistinctOn([versions.itemId], {
          itemId: versions.itemId,
          format: versions.format,
        })
        .from(versions)
        .where(
          and(inArray(versions.itemId, tree), eq(versions.origin, "imported")),
        )
        .orderBy(versions.itemId, versions.label, versions.id)
    : [];
  await db.transaction(async (tx) => {
    if (!played)
      await tx
        .delete(progress)
        .where(
          and(eq(progress.userId, userId), inArray(progress.itemId, tree)),
        );
    if (targets.length > 0)
      await tx
        .insert(progress)
        .values(
          targets.map((target) => ({
            userId,
            ...target,
            completed: true,
            positionSeconds: 0,
            playCount: 1,
            playedAt: playedAt ?? sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })),
        )
        .onConflictDoUpdate({
          target: [progress.userId, progress.itemId],
          set: {
            completed: true,
            positionSeconds: 0,
            playCount: sql`${progress.playCount} + 1`,
            playedAt: playedAt ?? sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          },
        });
    await publishEvent(tx, {
      kind: "user-data.changed",
      userId,
      itemIds: tree,
    });
  });
}

/** Sets or clears the caller's zero-to-ten, single-decimal rating on an Item. */
export async function setRating(
  db: MarksDb,
  userId: string,
  itemId: string,
  rating: number | null,
) {
  await viewableItem(db, userId, itemId);
  const pair = and(eq(ratings.userId, userId), eq(ratings.itemId, itemId));
  if (rating === null) {
    await db.transaction(async (tx) => {
      await tx.delete(ratings).where(and(pair, sql`${ratings.liked} is null`));
      await tx.update(ratings).set({ value: null }).where(pair);
    });
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
  await publishEvent(db, {
    kind: "user-data.changed",
    userId,
    itemIds: [itemId],
  });
  return getItemMarks(db, userId, itemId);
}

/** Sets or clears a binary opinion without changing the numeric rating. */
export async function setLiked(
  db: MarksDb,
  userId: string,
  itemId: string,
  liked: boolean | null,
) {
  await viewableItem(db, userId, itemId);
  const pair = and(eq(ratings.userId, userId), eq(ratings.itemId, itemId));
  await db.transaction(async (tx) => {
    if (liked === null) {
      await tx.delete(ratings).where(and(pair, sql`${ratings.value} is null`));
      await tx.update(ratings).set({ liked: null }).where(pair);
    } else {
      await tx
        .insert(ratings)
        .values({ userId, itemId, liked })
        .onConflictDoUpdate({
          target: [ratings.userId, ratings.itemId],
          set: { liked, updatedAt: sql`clock_timestamp()` },
        });
    }
    await publishEvent(tx, {
      kind: "user-data.changed",
      userId,
      itemIds: [itemId],
    });
  });
}

/** Imports partial personal item state atomically, without starting a playback session or counting an extra play. */
export async function updateItemState(
  db: MarksDb,
  userId: string,
  itemId: string,
  input: {
    positionSeconds?: number;
    completed?: boolean;
    playCount?: number;
    playedAt?: Date | null;
    favourite?: boolean;
    rating?: number | null;
    liked?: boolean | null;
  },
) {
  await viewableItem(db, userId, itemId);
  if (
    input.positionSeconds !== undefined &&
    (!Number.isFinite(input.positionSeconds) || input.positionSeconds < 0)
  )
    throw new AuthError("INVALID_INPUT");
  if (
    input.playCount !== undefined &&
    (!Number.isSafeInteger(input.playCount) || input.playCount < 0)
  )
    throw new AuthError("INVALID_INPUT");
  if (
    input.playedAt !== undefined &&
    input.playedAt !== null &&
    !Number.isFinite(input.playedAt.getTime())
  )
    throw new AuthError("INVALID_INPUT");
  await db.transaction(async (tx) => {
    if (input.favourite !== undefined)
      await setFavourite(tx, userId, itemId, input.favourite);
    if (input.rating !== undefined)
      await setRating(tx, userId, itemId, input.rating);
    if (input.liked !== undefined)
      await setLiked(tx, userId, itemId, input.liked);
    if (
      [
        input.positionSeconds,
        input.completed,
        input.playCount,
        input.playedAt,
      ].every((value) => value === undefined)
    )
      return;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${itemId}`}, 0))`,
    );
    const [previous] = await tx
      .select({ version: versions, playedAt: progress.playedAt })
      .from(progress)
      .leftJoin(versions, eq(versions.id, progress.versionId))
      .where(and(eq(progress.userId, userId), eq(progress.itemId, itemId)))
      .limit(1);
    // An import updates the existing play's position, so its duration belongs
    // to the selected Version, not whichever Version sorts first today.
    const version =
      previous?.version ??
      (
        await tx
          .select()
          .from(versions)
          .where(
            and(eq(versions.itemId, itemId), eq(versions.origin, "imported")),
          )
          .orderBy(versions.label, versions.id)
          .limit(1)
      )[0];
    if (version === undefined) return;
    const patch = {
      // An explicit position names this Version's timeline. An unrelated
      // count/date edit must not rebind an old, incompatible position.
      ...(input.positionSeconds === undefined
        ? {}
        : { versionId: version.id, format: version.format }),
      ...(input.positionSeconds === undefined
        ? {}
        : {
            positionSeconds: Math.min(
              input.positionSeconds,
              version.durationSeconds ?? Infinity,
            ),
          }),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
      ...(input.playCount === undefined ? {} : { playCount: input.playCount }),
      ...(input.playedAt !== undefined
        ? { playedAt: input.playedAt }
        : (input.positionSeconds ?? 0) > 0
          ? { playedAt: previous?.playedAt ?? new Date() }
          : {}),
      updatedAt: new Date(),
    };
    await tx
      .insert(progress)
      .values({
        userId,
        itemId,
        versionId: version.id,
        format: version.format,
        ...patch,
      })
      .onConflictDoUpdate({
        target: [progress.userId, progress.itemId],
        set: patch,
      });
    await publishEvent(tx, {
      kind: "user-data.changed",
      userId,
      itemIds: [itemId],
    });
  });
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
