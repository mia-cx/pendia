import {
  and,
  arrayOverlaps,
  asc,
  count,
  eq,
  inArray,
  isNull,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { viewableLibraryIds } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  contributors,
  credits,
  episodes,
  favourites,
  files,
  itemAncestors,
  items,
  libraries,
  movies,
  progress,
  providerIds,
  ratings,
  seasons,
  shows,
  streams,
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
  readonly genres?: readonly string[];
  readonly tags?: readonly string[];
  readonly years?: readonly number[];
  readonly contributorIds?: readonly string[];
  readonly contributorRoles?: readonly string[];
  readonly excludeIds?: readonly string[];
  readonly premiereBefore?: string;
  readonly premiereAfter?: string;
  readonly seasonNumber?: number;
  readonly indexNumber?: number;
  readonly contentRatings?: readonly string[];
  readonly hasOverview?: boolean;
  readonly hasContentRating?: boolean;
  readonly providerPresence?: Readonly<Record<string, boolean>>;
  readonly audioLanguages?: readonly string[];
  readonly subtitleLanguages?: readonly string[];
  readonly nameStartsWithOrGreater?: string;
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

function streamLanguages(
  kind: "audio" | "subtitle",
  languages: readonly string[] | undefined,
) {
  if (languages === undefined) return undefined;
  return sql`exists (select 1 from ${streams}
    inner join ${versions} on ${versions.id} = ${streams.versionId}
    where ${versions.itemId} = ${items.id} and ${streams.kind} = ${kind}
      and ${inArray(streams.language, [...languages])})`;
}

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
    query.excludeIds?.length
      ? notInArray(items.id, [...query.excludeIds])
      : undefined,
    query.genres === undefined
      ? undefined
      : query.genres.length
        ? arrayOverlaps(items.genres, [...query.genres])
        : sql`false`,
    query.tags === undefined
      ? undefined
      : query.tags.length
        ? arrayOverlaps(items.tags, [...query.tags])
        : sql`false`,
    query.years === undefined
      ? undefined
      : inArray(items.year, [...query.years]),
    query.contributorIds === undefined
      ? undefined
      : sql`exists (select 1 from ${credits} where ${credits.itemId} = ${items.id} and ${inArray(credits.contributorId, [...query.contributorIds])} ${query.contributorRoles?.length ? sql`and ${inArray(sql`lower(regexp_replace(${credits.role}, '[^a-zA-Z]', '', 'g'))`, [...query.contributorRoles])}` : sql``})`,
    query.premiereBefore === undefined
      ? undefined
      : sql`${premiereDate} <= ${query.premiereBefore}`,
    query.premiereAfter === undefined
      ? undefined
      : sql`${premiereDate} >= ${query.premiereAfter}`,
    query.seasonNumber === undefined
      ? undefined
      : sql`${seasonNumber} = ${query.seasonNumber}`,
    query.indexNumber === undefined
      ? undefined
      : sql`coalesce(${ownSeason.seasonNumber}, ${episodes.episodeNumber}) = ${query.indexNumber}`,
    query.contentRatings === undefined
      ? undefined
      : inArray(items.contentRating, [...query.contentRatings]),
    query.hasOverview === undefined
      ? undefined
      : sql`(coalesce(length(trim(${items.overview})), 0) > 0) = ${query.hasOverview}`,
    query.hasContentRating === undefined
      ? undefined
      : sql`(${items.contentRating} is not null) = ${query.hasContentRating}`,
    ...Object.entries(query.providerPresence ?? {}).map(
      ([provider, present]) =>
        sql`exists (select 1 from ${providerIds} where ${providerIds.itemId} = ${items.id} and ${providerIds.provider} = ${provider}) = ${present}`,
    ),
    streamLanguages("audio", query.audioLanguages),
    streamLanguages("subtitle", query.subtitleLanguages),
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
    query.nameStartsWithOrGreater === undefined
      ? undefined
      : sql`lower(${items.title}) collate "C" >= lower(${query.nameStartsWithOrGreater}) collate "C"`,
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

/**
 * Lists the imported video Versions of an Item the user may view, in label
 * order, each with its one File and that File's Streams in index order. A
 * Version split over several Files is left out, since playback cannot open it.
 */
export async function listVersionViews(
  db: Database,
  userId: string,
  itemId: string,
) {
  const viewable = await viewableLibraryIds(db, userId);
  if (viewable.length === 0) return [];
  const rows = await db
    .select({
      id: versions.id,
      label: versions.label,
      durationSeconds: versions.durationSeconds,
      file: {
        id: files.id,
        container: files.container,
        bytes: files.bytes,
        durationSeconds: files.durationSeconds,
      },
    })
    .from(versions)
    .innerJoin(files, eq(files.versionId, versions.id))
    .where(
      and(
        eq(versions.itemId, itemId),
        eq(versions.origin, "imported"),
        eq(versions.format, "video"),
        inArray(versions.libraryId, viewable),
      ),
    )
    .orderBy(asc(versions.label), asc(versions.id), asc(files.order));
  const single = rows.filter(
    (row) => rows.filter((other) => other.id === row.id).length === 1,
  );
  if (single.length === 0) return [];
  const fileStreams = await db
    .select()
    .from(streams)
    .where(
      inArray(
        streams.fileId,
        single.map((row) => row.file.id),
      ),
    )
    .orderBy(asc(streams.index));
  return single.map((row) => ({
    ...row,
    streams: fileStreams.filter((stream) => stream.fileId === row.file.id),
  }));
}

/** One playable Version of an Item with its File and Streams, as a translation layer lists it. */
export type VersionView = Awaited<ReturnType<typeof listVersionViews>>[number];

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

/** Lists distinct browse facets from matching, authorized items and their file streams. */
export async function listLibraryFacets(
  db: Database,
  userId: string,
  query: ItemViewQuery = {},
) {
  const viewable = await viewableLibraryIds(db, userId);
  const where = filtersOf(viewable, query);
  const matching = withJoins(
    db.select({ id: items.id }).from(items).$dynamic(),
    userId,
  ).where(where);
  const values = await withJoins(
    db
      .select({
        genres: sql<
          string[]
        >`coalesce(array_agg(distinct genre) filter (where genre is not null), '{}')`,
        tags: sql<
          string[]
        >`coalesce(array_agg(distinct tag) filter (where tag is not null), '{}')`,
        years: sql<
          number[] | Int32Array
        >`coalesce(array_agg(distinct ${items.year}) filter (where ${items.year} is not null), '{}')`,
        ratings: sql<
          string[]
        >`coalesce(array_agg(distinct ${items.contentRating}) filter (where ${items.contentRating} is not null), '{}')`,
      })
      .from(items)
      .$dynamic(),
    userId,
  )
    .leftJoin(sql`lateral unnest(${items.genres}) as genre`, sql`true`)
    .leftJoin(sql`lateral unnest(${items.tags}) as tag`, sql`true`)
    .where(where);
  const languages = await db
    .selectDistinct({ kind: streams.kind, language: streams.language })
    .from(streams)
    .innerJoin(files, eq(files.id, streams.fileId))
    .where(
      and(
        inArray(files.itemId, matching),
        sql`${streams.language} is not null`,
      ),
    );
  const facets = values[0] ?? { genres: [], tags: [], years: [], ratings: [] };
  return {
    genres: facets.genres.sort(),
    tags: facets.tags.sort(),
    // Bun decodes aggregate integer arrays as Int32Array; adapters need ordinary JSON arrays.
    years: Array.from(facets.years).sort((a, b) => a - b),
    ratings: facets.ratings.sort(),
    audioLanguages: languages
      .filter((row) => row.kind === "audio")
      .flatMap((row) => row.language ?? [])
      .sort(),
    subtitleLanguages: languages
      .filter((row) => row.kind === "subtitle")
      .flatMap((row) => row.language ?? [])
      .sort(),
  };
}

/** Reads contributor metadata and credits only for items the user may view. */
export async function listContributorCredits(
  db: Database,
  userId: string,
  query: ItemViewQuery = {},
) {
  const viewable = await viewableLibraryIds(db, userId);
  const matching = withJoins(
    db.select({ id: items.id }).from(items).$dynamic(),
    userId,
  ).where(filtersOf(viewable, query));
  return db
    .select({
      id: contributors.id,
      name: contributors.name,
      overview: contributors.overview,
      itemId: credits.itemId,
      role: credits.role,
      character: credits.character,
      order: credits.order,
    })
    .from(credits)
    .innerJoin(contributors, eq(contributors.id, credits.contributorId))
    .where(inArray(credits.itemId, matching))
    .orderBy(
      asc(contributors.name),
      asc(credits.role),
      asc(credits.order),
      asc(credits.id),
    );
}

/** Counts matching authorized items by their core kind without loading item rows. */
export async function countItemKinds(
  db: Database,
  userId: string,
  query: ItemViewQuery = {},
) {
  const viewable = await viewableLibraryIds(db, userId);
  return withJoins(
    db.select({ kind: items.kind, total: count() }).from(items).$dynamic(),
    userId,
  )
    .where(filtersOf(viewable, query))
    .groupBy(items.kind);
}
