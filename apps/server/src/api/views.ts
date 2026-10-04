import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { viewableLibraryIds } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  episodes,
  favourites,
  itemAncestors,
  items,
  libraries,
  movies,
  progress,
  providerIds,
  ratings,
  seasons,
  shows,
  versions,
} from "../db/schema/index.ts";

type ItemKind = (typeof items.kind.enumValues)[number];

/** The orders an Item view list can take. `number` walks seasons, then episodes. */
export type ItemViewSort =
  | "title"
  | "added"
  | "premiere"
  | "year"
  | "number"
  | "played";

/** Which Items to list and how. Every filter narrows the libraries the caller may view. */
export type ItemViewQuery = {
  readonly libraryIds?: readonly string[];
  /** Direct children of an Item; null lists the library roots. */
  readonly parentId?: string | null;
  /** Every descendant of an Item, at any depth. */
  readonly ancestorId?: string;
  readonly kinds?: readonly ItemKind[];
  readonly ids?: readonly string[];
  readonly search?: string;
  /** Titles starting with this text, ignoring case. */
  readonly nameStartsWith?: string;
  /** Titles that sort before this text, ignoring case. */
  readonly nameLessThan?: string;
  readonly favourite?: boolean;
  readonly played?: boolean;
  readonly resumable?: boolean;
  readonly sort?: readonly {
    readonly by: ItemViewSort;
    readonly descending?: boolean;
  }[];
  readonly offset?: number;
  readonly limit?: number;
};

const ownSeason = alias(seasons, "own_season");
const episodeSeason = alias(seasons, "episode_season");
const showItem = alias(items, "show_item");

// Columns are named in full: inside a subquery an unqualified id binds to the inner table.
const selectedArtwork = (owner: "items" | "show_item", type: string) =>
  sql<string | null>`(
    select ${artwork.id} from ${artwork}
    where ${artwork.itemId} = ${sql.identifier(owner)}."id"
      and ${artwork.type} = ${type} and ${artwork.selected}
    limit 1
  )`;

const premiereDate = sql<
  string | null
>`coalesce(${movies.releaseDate}, ${shows.firstAirDate}, ${ownSeason.airDate}, ${episodes.airDate})::text`;
const seasonNumber = sql<
  number | null
>`coalesce(${ownSeason.seasonNumber}, ${episodeSeason.seasonNumber})`;

const viewFields = {
  id: items.id,
  kind: items.kind,
  libraryId: items.libraryId,
  parentId: items.parentId,
  title: items.title,
  year: items.year,
  overview: items.overview,
  contentRating: items.contentRating,
  genres: items.genres,
  tags: items.tags,
  addedAt: items.addedAt,
  premiereDate,
  endDate: sql<string | null>`${shows.lastAirDate}::text`,
  status: shows.status,
  seasonNumber,
  episodeNumber: episodes.episodeNumber,
  episodeEndNumber: episodes.episodeEndNumber,
  seasonId: episodes.seasonId,
  showId: showItem.id,
  showTitle: showItem.title,
  showPoster: selectedArtwork("show_item", "poster"),
  showBackdrop: selectedArtwork("show_item", "backdrop"),
  poster: selectedArtwork("items", "poster"),
  backdrop: selectedArtwork("items", "backdrop"),
  logo: selectedArtwork("items", "logo"),
  thumb: selectedArtwork("items", "thumb"),
  // The first imported Version in label order, as the detail screen lists them.
  durationSeconds: sql<number | null>`(
    select ${versions.durationSeconds} from ${versions}
    where ${versions.itemId} = ${items.id} and ${versions.origin} = 'imported'
    order by ${versions.label}, ${versions.id}
    limit 1
  )`,
  childCount: sql<number>`(
    select count(*)::int from ${items} as child where child.parent_id = ${items.id}
  )`,
  providerIds: sql<Record<string, string>>`(
    select coalesce(jsonb_object_agg(${providerIds.provider}, ${providerIds.value}), '{}'::jsonb)
    from ${providerIds} where ${providerIds.itemId} = ${items.id}
  )`,
  positionSeconds: progress.positionSeconds,
  completed: progress.completed,
  playCount: progress.playCount,
  playedAt: progress.playedAt,
  favourite: sql<boolean>`${favourites.id} is not null`,
  rating: ratings.value,
};

const sortColumns: Record<ItemViewSort, SQL[]> = {
  title: [sql`${items.title}`],
  added: [sql`${items.addedAt}`],
  premiere: [premiereDate],
  year: [sql`${items.year}`],
  number: [seasonNumber, sql`${episodes.episodeNumber}`],
  played: [sql`${progress.playedAt}`],
};

function orderOf(sort: ItemViewQuery["sort"]): SQL[] {
  const keys = sort?.length
    ? sort
    : [{ by: "number" as const }, { by: "title" as const }];
  return [
    ...keys.flatMap(({ by, descending }) =>
      sortColumns[by].map((column) =>
        descending
          ? sql`${column} desc nulls last`
          : sql`${column} asc nulls last`,
      ),
    ),
    asc(items.id),
  ];
}

function filtersOf(viewable: string[], query: ItemViewQuery) {
  const requested = query.libraryIds;
  const scope =
    requested === undefined
      ? viewable
      : viewable.filter((id) => requested.includes(id));
  const { parentId, ancestorId, kinds, ids, search } = query;
  return and(
    inArray(items.libraryId, scope),
    parentId === undefined
      ? undefined
      : parentId === null
        ? isNull(items.parentId)
        : eq(items.parentId, parentId),
    ancestorId === undefined
      ? undefined
      : sql`exists (
          select 1 from ${itemAncestors}
          where ${itemAncestors.ancestorId} = ${ancestorId}
            and ${itemAncestors.descendantId} = ${items.id}
            and ${itemAncestors.depth} > 0
        )`,
    kinds === undefined ? undefined : inArray(items.kind, [...kinds]),
    ids === undefined ? undefined : inArray(items.id, [...ids]),
    search === undefined
      ? undefined
      : sql`(${items.title} % ${search} or ${search} <% ${items.title})`,
    query.nameStartsWith === undefined
      ? undefined
      : sql`starts_with(lower(${items.title}), lower(${query.nameStartsWith}))`,
    // Byte order, so "#" in a letter picker means digits and symbols before "a".
    query.nameLessThan === undefined
      ? undefined
      : sql`lower(${items.title}) collate "C" < lower(${query.nameLessThan}) collate "C"`,
    query.favourite === undefined
      ? undefined
      : sql`(${favourites.id} is not null) = ${query.favourite}`,
    query.played === undefined
      ? undefined
      : sql`coalesce(${progress.completed}, false) = ${query.played}`,
    query.resumable === undefined
      ? undefined
      : sql`(coalesce(not ${progress.completed} and ${progress.positionSeconds} > 0, false)) = ${query.resumable}`,
  );
}

// Every join adds at most one row per Item, so a count over the same joins stays exact.
function withJoins<T extends PgSelect>(query: T, userId: string) {
  return query
    .leftJoin(movies, eq(movies.itemId, items.id))
    .leftJoin(shows, eq(shows.itemId, items.id))
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
    .leftJoin(
      progress,
      and(eq(progress.itemId, items.id), eq(progress.userId, userId)),
    )
    .leftJoin(
      favourites,
      and(eq(favourites.itemId, items.id), eq(favourites.userId, userId)),
    )
    .leftJoin(
      ratings,
      and(eq(ratings.itemId, items.id), eq(ratings.userId, userId)),
    );
}

type ViewRow = Awaited<ReturnType<typeof selectViews>>[number];

function selectViews(
  db: Database,
  userId: string,
  where: SQL | undefined,
  query: ItemViewQuery,
) {
  let select = withJoins(db.select(viewFields).from(items).$dynamic(), userId)
    .where(where)
    .orderBy(...orderOf(query.sort))
    .offset(query.offset ?? 0);
  if (query.limit !== undefined) select = select.limit(query.limit);
  return select;
}

function toView(row: ViewRow) {
  const {
    showId,
    showTitle,
    showPoster,
    showBackdrop,
    poster,
    backdrop,
    logo,
    thumb,
    positionSeconds,
    completed,
    playCount,
    playedAt,
    favourite,
    rating,
    ...item
  } = row;
  return {
    ...item,
    show:
      showId === null || showTitle === null
        ? null
        : {
            id: showId,
            title: showTitle,
            artwork: { poster: showPoster, backdrop: showBackdrop },
          },
    artwork: { poster, backdrop, logo, thumb },
    marks: {
      positionSeconds: positionSeconds ?? 0,
      completed: completed ?? false,
      playCount: playCount ?? 0,
      playedAt,
      favourite,
      rating: rating === null ? null : Number(rating),
    },
  };
}

/** One Item as a translation layer shows it: medium fields, selected artwork, provider ids and the caller's marks. */
export type ItemView = ReturnType<typeof toView>;

/**
 * Lists Item views the user may see, offset-paged, with the total that match.
 * Items outside the user's viewable libraries never match, so a denied id reads as absent.
 */
export async function listItemViews(
  db: Database,
  userId: string,
  query: ItemViewQuery,
): Promise<{ items: ItemView[]; total: number }> {
  const viewable = await viewableLibraryIds(db, userId);
  const where = filtersOf(viewable, query);
  if (viewable.length === 0) return { items: [], total: 0 };
  const [rows, [counted]] = await Promise.all([
    selectViews(db, userId, where, query),
    withJoins(
      db.select({ total: count() }).from(items).$dynamic(),
      userId,
    ).where(where),
  ]);
  return { items: rows.map(toView), total: counted?.total ?? 0 };
}

/** Lists the libraries a user may view, by name. */
export async function viewableLibraries(db: Database, userId: string) {
  const viewable = await viewableLibraryIds(db, userId);
  if (viewable.length === 0) return [];
  return db
    .select({
      id: libraries.id,
      name: libraries.name,
      medium: libraries.medium,
    })
    .from(libraries)
    .where(inArray(libraries.id, viewable))
    .orderBy(asc(libraries.name), asc(libraries.id));
}
