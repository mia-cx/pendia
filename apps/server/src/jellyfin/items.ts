import { maxPageSize } from "../api/pagination.ts";
import {
  type ItemView,
  type ItemViewQuery,
  type ItemViewSort,
  listContributorCredits,
  listItemViews,
  listLibraryFacets,
  listVersionViews,
  viewableLibraries,
} from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { nextUp } from "../mediums/shows.ts";
import { continueWatching } from "../playback/marks.ts";
import { readServerId } from "../server-id.ts";
import { facetId, personType } from "./facets.ts";
import { json, type Route, type UserContext } from "./http.ts";
import { mediaSource } from "./media.ts";
import {
  parseGuid,
  type Query,
  requiredGuid,
  ticksPerSecond,
  toGuid,
} from "./request.ts";

type Kind = ItemView["kind"];
type Library = Awaited<ReturnType<typeof viewableLibraries>>[number];

const itemTypes = {
  movie: "Movie",
  show: "Series",
  season: "Season",
  episode: "Episode",
} as const satisfies Record<Kind, string>;

const playableKinds = new Set<Kind>(["movie", "episode"]);

const collectionTypes = { movies: "movies", shows: "tvshows" } as const;

// Jellyfin's ItemSortBy names, lowercased, for the orders Thalia can serve.
const sortsByName = new Map<string, ItemViewSort>([
  ["sortname", "title"],
  ["name", "title"],
  ["datecreated", "added"],
  ["premieredate", "premiere"],
  ["productionyear", "year"],
  ["dateplayed", "played"],
  ["parentindexnumber", "number"],
  ["indexnumber", "number"],
]);

const tag = (id: string | null) => (id === null ? undefined : toGuid(id));
const date = (day: string | null) =>
  day === null ? undefined : `${day}T00:00:00.0000000Z`;
const capitalised = (name: string) =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/** Builds a Jellyfin UserItemDataDto from the caller's marks on an Item view. */
export function userData(view: ItemView) {
  const { marks, durationSeconds } = view;
  return {
    Rating: marks.rating ?? undefined,
    PlayedPercentage:
      durationSeconds && !marks.completed && marks.positionSeconds > 0
        ? (marks.positionSeconds / durationSeconds) * 100
        : undefined,
    PlaybackPositionTicks: Math.round(marks.positionSeconds * ticksPerSecond),
    PlayCount: marks.playCount,
    IsFavorite: marks.favourite,
    LastPlayedDate: marks.playedAt?.toISOString(),
    Played: marks.completed,
    Key: toGuid(view.id),
    ItemId: toGuid(view.id),
  };
}

/** Builds a Jellyfin BaseItemDto from an Item view. */
export function baseItemDto(view: ItemView, serverId: string) {
  const playable = playableKinds.has(view.kind);
  const show = view.show;
  const showBackdrop = show?.artwork.backdrop ?? null;
  return {
    Name: view.title,
    ServerId: toGuid(serverId),
    Id: toGuid(view.id),
    DateCreated: view.addedAt.toISOString(),
    CanDelete: false,
    CanDownload: false,
    SortName: view.title,
    PremiereDate: date(view.premiereDate),
    EndDate: date(view.endDate),
    OfficialRating: view.contentRating ?? undefined,
    Overview: view.overview ?? undefined,
    Genres: view.genres,
    GenreItems: view.genres.map((name) => ({
      Name: name,
      Id: facetId("Genre", name),
    })),
    Tags: view.tags,
    ProductionYear: view.year ?? undefined,
    IndexNumber:
      (view.kind === "season" ? view.seasonNumber : view.episodeNumber) ??
      undefined,
    IndexNumberEnd: view.episodeEndNumber ?? undefined,
    ParentIndexNumber:
      view.kind === "episode" ? (view.seasonNumber ?? undefined) : undefined,
    ProviderIds: Object.fromEntries(
      Object.entries(view.providerIds).map(([name, value]) => [
        capitalised(name),
        value,
      ]),
    ),
    IsFolder: !playable,
    // Roots sit in their library's view, as Jellyfin's CollectionFolder.
    ParentId: toGuid(view.parentId ?? view.libraryId),
    Type: itemTypes[view.kind],
    SeriesName: show?.title,
    SeriesId: show === null ? undefined : toGuid(show.id),
    SeasonId: view.seasonId === null ? undefined : toGuid(view.seasonId),
    SeriesPrimaryImageTag: tag(show?.artwork.poster ?? null),
    ParentBackdropItemId:
      show === null || showBackdrop === null ? undefined : toGuid(show.id),
    ParentBackdropImageTags:
      showBackdrop === null ? undefined : [toGuid(showBackdrop)],
    UserData: userData(view),
    RunTimeTicks:
      view.durationSeconds === null
        ? undefined
        : Math.round(view.durationSeconds * ticksPerSecond),
    ChildCount: playable ? undefined : view.childCount,
    Status: view.status ?? undefined,
    PlayAccess: "Full",
    LocationType: "FileSystem",
    VideoType: playable ? "VideoFile" : undefined,
    MediaType: playable ? "Video" : "Unknown",
    ImageTags: Object.fromEntries(
      (
        [
          ["Primary", view.artwork.poster],
          ["Logo", view.artwork.logo],
          ["Thumb", view.artwork.thumb],
        ] as const
      ).flatMap(([type, id]) => (id === null ? [] : [[type, toGuid(id)]])),
    ),
    BackdropImageTags:
      view.artwork.backdrop === null ? [] : [toGuid(view.artwork.backdrop)],
  };
}

/** Builds the CollectionFolder a library appears as in Jellyfin's user views. */
export function libraryDto(library: Library, serverId: string) {
  return {
    Name: library.name,
    ServerId: toGuid(serverId),
    Id: toGuid(library.id),
    SortName: library.name,
    IsFolder: true,
    Type: "CollectionFolder",
    CollectionType: collectionTypes[library.medium],
    PlayAccess: "Full",
    LocationType: "FileSystem",
    MediaType: "Unknown",
    ImageTags: {},
    BackdropImageTags: [],
  };
}

function queryResult(items: unknown[], total: number, startIndex: number) {
  return { Items: items, TotalRecordCount: total, StartIndex: startIndex };
}

// Pages a list already in memory, as StartIndex and Limit ask.
function paged<T>(list: T[], page: { offset: number; limit?: number }) {
  const { offset, limit } = page;
  return list.slice(offset, limit === undefined ? undefined : offset + limit);
}

async function librariesResult(
  db: Database,
  libraries: Library[],
  page: { offset: number; limit?: number } = { offset: 0 },
) {
  const serverId = await readServerId(db);
  return json(
    queryResult(
      paged(libraries, page).map((library) => libraryDto(library, serverId)),
      libraries.length,
      page.offset,
    ),
  );
}

function guids(values: string[]) {
  return values.flatMap((value) => parseGuid(value) ?? []);
}

/** Reads IncludeItemTypes, ExcludeItemTypes and MediaTypes. Undefined means every kind. */
function kindsOf(query: Query): Kind[] | undefined {
  const lowered = (name: string) =>
    new Set(query.list(name).map((value) => value.toLowerCase()));
  const include = lowered("includeItemTypes");
  for (const value of query.list("type")) include.add(value.toLowerCase());
  if (query.flag("isMovie") === true) include.add("movie");
  if (query.flag("isSeries") === true) include.add("series");
  const exclude = lowered("excludeItemTypes");
  const media = lowered("mediaTypes");
  for (const value of query.list("mediaType")) media.add(value.toLowerCase());
  if (
    include.size === 0 &&
    exclude.size === 0 &&
    media.size === 0 &&
    query.flag("isMovie") === undefined &&
    query.flag("isSeries") === undefined
  )
    return undefined;
  const kinds = Object.keys(itemTypes) as Kind[];
  const typeOf = (kind: Kind) => itemTypes[kind].toLowerCase();
  // Every playable Thalia kind is a Video; folders have no media type.
  return kinds.filter(
    (kind) =>
      (include.size === 0 || include.has(typeOf(kind))) &&
      (query.flag("isMovie") !== false || kind !== "movie") &&
      (query.flag("isSeries") !== false || kind !== "show") &&
      !exclude.has(typeOf(kind)) &&
      (media.size === 0 || (media.has("video") && playableKinds.has(kind))),
  );
}

function sortOf(query: Query): ItemViewQuery["sort"] {
  const orders = query.list("sortOrder");
  return query.list("sortBy").flatMap((name, index) => {
    const by = sortsByName.get(name.toLowerCase());
    const order = orders[index] ?? orders[0];
    return by === undefined
      ? []
      : [{ by, descending: order?.toLowerCase() === "descending" }];
  });
}

function marksOf(query: Query) {
  const filters = new Set(
    query.list("filters").map((filter) => filter.toLowerCase()),
  );
  const played = filters.has("isplayed")
    ? true
    : filters.has("isunplayed")
      ? false
      : query.flag("isPlayed");
  return {
    favourite: filters.has("isfavorite") ? true : query.flag("isFavorite"),
    played,
    resumable: filters.has("isresumable") ? true : undefined,
  };
}

function pageOf(query: Query) {
  return {
    offset: query.count("startIndex") ?? 0,
    limit: query.count("limit"),
  };
}

/** Reads common browse filters once, including library scope and stable genre identifiers. */
export async function browseSelection({
  db,
  caller,
  query,
}: UserContext): Promise<ItemViewQuery> {
  const parent = query.get("parentId");
  const parentId = parent === undefined ? undefined : requiredGuid(parent);
  const library = (await viewableLibraries(db, caller.user.id)).find(
    (row) => row.id === parentId,
  );
  const genreIds = new Set(
    query.list("genreIds").map((value) => toGuid(requiredGuid(value))),
  );
  const genres = query.list("genres").flatMap((value) => value.split("|"));
  if (genreIds.size)
    genres.push(
      ...(await listLibraryFacets(db, caller.user.id)).genres.filter((name) =>
        genreIds.has(facetId("Genre", name)),
      ),
    );
  const people = guids([
    ...query.list("personIds"),
    ...query.list("actorIds"),
    ...query.list("directorIds"),
    ...query.list("writerIds"),
  ]);
  const date = (name: string) => {
    const value = query.get(name);
    if (value === undefined) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new AuthError("INVALID_INPUT");
    return parsed.toISOString().slice(0, 10);
  };
  return {
    libraryIds: library === undefined ? undefined : [library.id],
    ancestorId: library === undefined ? parentId : undefined,
    ids: query.list("ids").length ? guids(query.list("ids")) : undefined,
    kinds: kindsOf(query),
    search: query.get("searchTerm"),
    genres: genres.length || genreIds.size ? genres : undefined,
    tags: query.list("tags").length
      ? query.list("tags").flatMap((value) => value.split("|"))
      : undefined,
    years: query.list("years").length
      ? query.list("years").map((value) => {
          const year = Number(value);
          if (!Number.isSafeInteger(year)) throw new AuthError("INVALID_INPUT");
          return year;
        })
      : undefined,
    contributorIds: people.length ? people : undefined,
    contributorRoles: query
      .list("personTypes")
      .map((role) => role.toLowerCase().replaceAll(/[^a-z]/g, "")),
    excludeIds: guids(query.list("excludeItemIds")),
    premiereAfter: date("minPremiereDate"),
    premiereBefore: date("maxPremiereDate"),
    indexNumber: query.integer("indexNumber"),
    seasonNumber: query.integer("parentIndexNumber"),
    contentRatings: query.list("officialRatings").length
      ? query.list("officialRatings").flatMap((value) => value.split("|"))
      : undefined,
    hasOverview: query.flag("hasOverview"),
    hasContentRating:
      query.flag("hasOfficialRating") ?? query.flag("hasParentalRating"),
    providerPresence: Object.fromEntries(
      ["tmdb", "tvdb", "imdb"].flatMap((provider) => {
        const present = query.flag(`has${provider}Id`);
        return present === undefined ? [] : [[provider, present]];
      }),
    ),
    audioLanguages: query.list("audioLanguages").length
      ? query.list("audioLanguages").flatMap((value) => value.split("|"))
      : undefined,
    subtitleLanguages: query.list("subtitleLanguages").length
      ? query.list("subtitleLanguages").flatMap((value) => value.split("|"))
      : undefined,
    nameStartsWithOrGreater: query.get("nameStartsWithOrGreater"),
    nameStartsWith: query.get("nameStartsWith"),
    nameLessThan: query.get("nameLessThan"),
    ...marksOf(query),
    sort: sortOf(query),
    ...pageOf(query),
  };
}

/** Serializes a paged core selection with the Jellyfin total and offset. */
export async function viewsResult(
  { db, caller }: UserContext,
  query: ItemViewQuery,
) {
  const [page, serverId] = await Promise.all([
    listItemViews(db, caller.user.id, query),
    readServerId(db),
  ]);
  return json(
    queryResult(
      page.items.map((view) => baseItemDto(view, serverId)),
      page.total,
      query.offset ?? 0,
    ),
  );
}

// Shelves hand back ordered ids; the views keep that order, are narrowed, then paged.
async function shelfResult(
  context: UserContext,
  ids: string[],
  select: (views: ItemView[]) => ItemView[] = (views) => views,
) {
  const { db, caller, query } = context;
  const kinds = kindsOf(query);
  const [found, serverId] = await Promise.all([
    listItemViews(db, caller.user.id, { ids, kinds }),
    readServerId(db),
  ]);
  const byId = new Map(found.items.map((view) => [view.id, view]));
  const views = select(ids.flatMap((id) => byId.get(id) ?? []));
  const page = pageOf(query);
  return json(
    queryResult(
      paged(views, page).map((view) => baseItemDto(view, serverId)),
      views.length,
      page.offset,
    ),
  );
}

async function showViews(
  context: UserContext,
  query: Omit<ItemViewQuery, "sort" | "offset" | "limit">,
) {
  return viewsResult(context, {
    ...query,
    ...pageOf(context.query),
    sort: [{ by: "number" }, { by: "title" }],
  });
}

/** User views, items, resume, next up, seasons and episodes. */
export const browseRoutes: Route[] = [
  {
    method: "GET",
    path: "/UserViews",
    handle: async ({ db, caller }) =>
      librariesResult(db, await viewableLibraries(db, caller.user.id)),
  },
  {
    method: "GET",
    path: "/Items",
    handle: async (context) => {
      const { db, caller, query } = context;
      const parent = query.get("parentId");
      const parentId = parent === undefined ? undefined : requiredGuid(parent);
      const recursive = query.flag("recursive") ?? false;
      const libraries = await viewableLibraries(db, caller.user.id);
      const library = libraries.find((candidate) => candidate.id === parentId);
      const ids = query.list("ids");
      const kinds = kindsOf(query);
      // Without a parent, a flat listing is the user's root folder: the libraries.
      // Findroid lists libraries this way. No Item kind is a library folder.
      if (parentId === undefined && !recursive && ids.length === 0)
        return librariesResult(
          db,
          kinds === undefined ? libraries : [],
          pageOf(query),
        );
      if (kinds?.length === 0)
        return json(queryResult([], 0, pageOf(query).offset));
      return viewsResult(context, {
        ...(await browseSelection(context)),
        ...(library !== undefined
          ? { libraryIds: [library.id], parentId: recursive ? undefined : null }
          : recursive
            ? { ancestorId: parentId }
            : { parentId }),
        ids: ids.length === 0 ? undefined : guids(ids),
        kinds,
        search: query.get("searchTerm"),
        // Swiftfin's letter picker: a letter, or `NameLessThan=A` for "#".
        nameStartsWith: query.get("nameStartsWith"),
        nameLessThan: query.get("nameLessThan"),
        ...marksOf(query),
        sort: sortOf(query),
        ...pageOf(query),
      });
    },
  },
  {
    method: "GET",
    path: "/Items/{id}",
    handle: async ({ db, caller, params }) => {
      const id = requiredGuid(params.id);
      const [libraries, page, serverId] = await Promise.all([
        viewableLibraries(db, caller.user.id),
        listItemViews(db, caller.user.id, { ids: [id] }),
        readServerId(db),
      ]);
      const library = libraries.find((candidate) => candidate.id === id);
      if (library !== undefined) return json(libraryDto(library, serverId));
      const [view] = page.items;
      if (view === undefined) {
        const person = (await listContributorCredits(db, caller.user.id)).find(
          (person) => person.id === id,
        );
        if (person !== undefined)
          return json({
            Id: toGuid(person.id),
            Name: person.name,
            Overview: person.overview,
            Type: "Person",
            ServerId: toGuid(serverId),
            IsFolder: true,
          });
        const facets = await listLibraryFacets(db, caller.user.id);
        const facet = [
          ...facets.genres.map((name) => ({ name, type: "Genre" })),
          ...facets.years.map((year) => ({ name: String(year), type: "Year" })),
        ].find((value) => facetId(value.type, value.name) === toGuid(id));
        if (facet !== undefined)
          return json({
            Id: toGuid(id),
            Name: facet.name,
            Type: facet.type,
            IsFolder: true,
          });
        throw new AuthError("NOT_FOUND");
      }
      const dto = {
        ...baseItemDto(view, serverId),
        People: (
          await listContributorCredits(db, caller.user.id, { ids: [id] })
        ).map((person) => ({
          Id: toGuid(person.id),
          Name: person.name,
          Role: person.character ?? person.role,
          Type: personType(person.role),
        })),
      };
      if (!playableKinds.has(view.kind)) return json(dto);
      // Swiftfin and Infuse pick a Version from the detail before they play.
      const sources = (await listVersionViews(db, caller.user.id, id)).map(
        (version) => mediaSource(id, version),
      );
      return json({
        ...dto,
        MediaSources: sources,
        MediaStreams: sources[0]?.MediaStreams ?? [],
      });
    },
  },
  {
    method: "GET",
    path: "/UserItems/Resume",
    handle: async (context) => {
      // The own API's page cap bounds resume to the most recent entries.
      const page = await continueWatching(context.db, context.caller.user.id, {
        limit: maxPageSize,
      });
      return shelfResult(
        context,
        page.items.map((row) => row.item.id),
      );
    },
  },
  {
    method: "GET",
    path: "/Shows/NextUp",
    handle: async (context) => {
      const { db, caller, query } = context;
      const series = query.get("seriesId");
      const showId = series === undefined ? undefined : requiredGuid(series);
      const resumable = query.flag("enableResumable") ?? true;
      const ids = await nextUp(db, caller.user.id);
      // A named Show with no finished episode offers its first one, specials
      // aside. Once one is finished, only the shelf's pick after it counts.
      if (showId !== undefined) {
        const episodes = await listItemViews(db, caller.user.id, {
          ancestorId: showId,
          kinds: ["episode"],
          sort: [{ by: "number" }],
        });
        const started = episodes.items.some((view) => view.marks.completed);
        const first = episodes.items.find((view) => view.seasonNumber !== 0);
        if (!started && first !== undefined) ids.push(first.id);
      }
      return shelfResult(context, ids, (views) => {
        const seen = new Set<string>();
        return views.filter((view) => {
          const show = view.show?.id;
          if (show === undefined || seen.has(show)) return false;
          if (showId !== undefined && show !== showId) return false;
          seen.add(show);
          // Jellyfin leaves a started episode to Resume rather than skip past it.
          return resumable || view.marks.positionSeconds === 0;
        });
      });
    },
  },
  {
    method: "GET",
    path: "/Shows/{id}/Seasons",
    handle: (context) =>
      showViews(context, {
        parentId: requiredGuid(context.params.id),
        kinds: ["season"],
      }),
  },
  {
    method: "GET",
    path: "/Shows/{id}/Episodes",
    handle: (context) => {
      const season = context.query.get("seasonId");
      return showViews(context, {
        ancestorId: requiredGuid(context.params.id),
        parentId: season === undefined ? undefined : requiredGuid(season),
        kinds: ["episode"],
        seasonNumber: context.query.integer("season"),
      });
    },
  },
];
