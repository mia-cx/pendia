import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Schema } from "effect";
import { Effect } from "effect";
import { AuthError } from "../auth/errors.ts";
import { requirePermission, viewableLibraryIds } from "../auth/permissions.ts";
import type { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  contributors,
  credits,
  episodes,
  items,
  seasons,
  versions,
} from "../db/schema/index.ts";
import { ApiError, fromHost } from "./errors.ts";
import {
  after,
  afterTitle,
  decodeCursor,
  decodeTitleCursor,
  defaultPageSize,
  encodeCursor,
  encodeTitleCursor,
  toPageBy,
} from "./pagination.ts";
import type { ItemKind, ItemSort } from "./schema.ts";

/** The authenticated caller the middleware places in context. */
export type Caller = Awaited<ReturnType<typeof authenticate>>;

/** The decoded items.list input. */
export type ListItemsInput = {
  readonly libraryId?: string;
  readonly kind?: Schema.Schema.Type<typeof ItemKind>;
  readonly sort?: Schema.Schema.Type<typeof ItemSort>;
  readonly limit?: number;
  readonly cursor?: string;
};

// Instants cross the API as the database's own UTC text at microsecond
// precision, so a cursor never rounds a timestamp the driver truncated.
const instantText = (column: typeof items.addedAt) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// A single-table select renders columns unqualified, which would bind to
// artwork's own id inside the subquery, so the owner is named in full.
const selectedArtwork = (owner: "items" | "show_item", type: string) =>
  sql<string | null>`(
    select ${artwork.id}
    from ${artwork}
    where ${artwork.itemId} = ${sql.identifier(owner)}."id"
      and ${artwork.type} = ${type}
      and ${artwork.selected} = true
    limit 1
  )`;

const cardFields = {
  id: items.id,
  kind: items.kind,
  libraryId: items.libraryId,
  title: items.title,
  year: items.year,
  addedAt: instantText(items.addedAt),
  posterArtworkId: selectedArtwork("items", "poster"),
};

// A Season names its Show directly; an Episode reaches it through its Season.
const ownSeason = alias(seasons, "own_season");
const episodeSeason = alias(seasons, "episode_season");
const showItem = alias(items, "show_item");

const browseFields = {
  ...cardFields,
  parentId: items.parentId,
  seasonNumber: sql<
    number | null
  >`coalesce(${ownSeason.seasonNumber}, ${episodeSeason.seasonNumber})`,
  episodeNumber: episodes.episodeNumber,
  episodeEndNumber: episodes.episodeEndNumber,
  showId: showItem.id,
  showTitle: showItem.title,
  showPosterArtworkId: selectedArtwork("show_item", "poster"),
};

/** Reads browse cards: item cards with their numbers and owning Show. */
export async function browseCards(
  db: Database,
  where: SQL | undefined,
  orderBy: SQL[] = [],
  limit?: number,
) {
  const query = db
    .select(browseFields)
    .from(items)
    .leftJoin(ownSeason, eq(ownSeason.itemId, items.id))
    .leftJoin(episodes, eq(episodes.itemId, items.id))
    .leftJoin(episodeSeason, eq(episodeSeason.itemId, episodes.seasonId))
    .leftJoin(
      showItem,
      eq(
        showItem.id,
        sql`coalesce(${ownSeason.showId}, ${episodeSeason.showId})`,
      ),
    )
    .where(where)
    .orderBy(...orderBy);
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map(({ showId, showTitle, showPosterArtworkId, ...card }) => ({
    ...card,
    show:
      showId === null || showTitle === null
        ? null
        : {
            id: showId,
            title: showTitle,
            posterArtworkId: showPosterArtworkId,
          },
  }));
}

/** Reads browse cards for ids the caller may already view, in the order given. */
export async function browseCardsById(db: Database, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const cards = await browseCards(db, inArray(items.id, [...ids]));
  const byId = new Map(cards.map((card) => [card.id, card]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

const detailFields = {
  overview: items.overview,
  contentRating: items.contentRating,
  genres: items.genres,
  tags: items.tags,
  metadataState: items.metadataState,
  updatedAt: instantText(items.updatedAt),
  backdropArtworkId: selectedArtwork("items", "backdrop"),
};

// Each sort owns its order, its keyset predicate and its cursor encoding.
// An undefined `after` with a cursor means the cursor belongs to another sort.
function sortPlan(sort: ListItemsInput["sort"], cursor: string | undefined) {
  if (sort === "title") {
    const key = cursor === undefined ? undefined : decodeTitleCursor(cursor);
    return {
      after: key === undefined ? undefined : afterTitle(key),
      orderBy: [asc(items.title), asc(items.id)],
      cursorOf: (row: { title: string; id: string }) => encodeTitleCursor(row),
    };
  }
  const key = cursor === undefined ? undefined : decodeCursor(cursor);
  return {
    after: key === undefined ? undefined : after(key),
    orderBy: [desc(items.addedAt), desc(items.id)],
    cursorOf: (row: { addedAt: string; id: string }) => encodeCursor(row),
  };
}

/** Lists item cards newest first or by title, paginated by the opaque cursor. */
export function listItemCards(
  db: Database,
  caller: Caller,
  input: ListItemsInput,
) {
  return Effect.gen(function* () {
    // Without a library the list is scoped to every library the caller may view.
    const scope = yield* fromHost(async () => {
      if (input.libraryId !== undefined) {
        await requirePermission(db, caller.user.id, "view", input.libraryId);
        return eq(items.libraryId, input.libraryId);
      }
      const viewable = await viewableLibraryIds(db, caller.user.id);
      if (viewable.length === 0) throw new AuthError("FORBIDDEN");
      return inArray(items.libraryId, viewable);
    });
    const limit = input.limit ?? defaultPageSize;
    const plan = sortPlan(input.sort, input.cursor);
    if (input.cursor !== undefined && plan.after === undefined)
      return yield* new ApiError({
        code: "BAD_REQUEST",
        reason: "Unknown cursor.",
      });
    const rows = yield* fromHost(() =>
      db
        .select(cardFields)
        .from(items)
        .where(
          and(
            scope,
            input.kind === undefined ? undefined : eq(items.kind, input.kind),
            plan.after,
          ),
        )
        .orderBy(...plan.orderBy)
        .limit(limit + 1),
    );
    return toPageBy(rows, limit, plan.cursorOf);
  });
}

/** Reads one item's detail, checking access to the library that holds it. */
export function getItemDetail(db: Database, caller: Caller, id: string) {
  return Effect.gen(function* () {
    const [card] = yield* fromHost(() => browseCards(db, eq(items.id, id)));
    if (!card) return yield* new ApiError({ code: "NOT_FOUND" });
    yield* fromHost(() =>
      requirePermission(db, caller.user.id, "view", card.libraryId),
    );
    const [[detail], itemCredits, itemVersions, children] = yield* fromHost(
      () =>
        Promise.all([
          db.select(detailFields).from(items).where(eq(items.id, id)),
          db
            .select({
              contributorId: contributors.id,
              name: contributors.name,
              role: credits.role,
              character: credits.character,
            })
            .from(credits)
            .innerJoin(contributors, eq(contributors.id, credits.contributorId))
            .where(eq(credits.itemId, id))
            .orderBy(
              sql`${credits.role} <> 'actor'`,
              asc(credits.role),
              asc(credits.order),
              asc(credits.id),
            ),
          db
            .select({
              id: versions.id,
              label: versions.label,
              format: versions.format,
              durationSeconds: versions.durationSeconds,
              bytes: versions.bytes,
            })
            .from(versions)
            .where(
              and(eq(versions.itemId, id), eq(versions.origin, "imported")),
            )
            .orderBy(asc(versions.label), asc(versions.id)),
          browseCards(db, eq(items.parentId, id), [
            sql`${ownSeason.seasonNumber} nulls last`,
            sql`${episodes.episodeNumber} nulls last`,
            asc(items.title),
            asc(items.id),
          ]),
        ]),
    );
    if (!detail) return yield* new ApiError({ code: "NOT_FOUND" });
    return {
      ...card,
      ...detail,
      credits: itemCredits,
      // JSON has no bigint; a byte count stays exact below 2^53.
      versions: itemVersions.map((version) => ({
        ...version,
        bytes: Number(version.bytes),
      })),
      children,
    };
  });
}

/** The most results a search answers with. */
export const searchLimit = 24;

/**
 * Finds the Movies and Shows the caller may view whose titles resemble the
 * query, best match first. Trigram similarity forgives a misspelling; word
 * similarity lets a prefix or one word of a longer title match.
 */
export function searchItems(db: Database, caller: Caller, query: string) {
  return Effect.gen(function* () {
    const viewable = yield* fromHost(() =>
      viewableLibraryIds(db, caller.user.id),
    );
    if (viewable.length === 0) return [];
    return yield* fromHost(() =>
      db
        .select(cardFields)
        .from(items)
        .where(
          and(
            inArray(items.libraryId, viewable),
            inArray(items.kind, ["movie", "show"]),
            sql`(${items.title} % ${query} or ${query} <% ${items.title})`,
          ),
        )
        .orderBy(
          sql`word_similarity(${query}, ${items.title}) desc`,
          sql`similarity(${items.title}, ${query}) desc`,
          asc(items.title),
          asc(items.id),
        )
        .limit(searchLimit),
    );
  });
}
