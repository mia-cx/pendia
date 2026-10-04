import { maxPageSize } from "../api/pagination.ts";
import {
  type ItemView,
  type ItemViewQuery,
  type ItemViewSort,
  listItemViews,
  viewableLibraries,
} from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { nextUp } from "../mediums/shows.ts";
import { continueWatching } from "../playback/marks.ts";
import { readServerId } from "../server-id.ts";
import { json, type Route, type UserContext } from "./http.ts";
import { parseGuid, type Query, toGuid } from "./request.ts";

type Kind = ItemView["kind"];
type Library = Awaited<ReturnType<typeof viewableLibraries>>[number];

const ticksPerSecond = 10_000_000;

const itemTypes = {
  movie: "Movie",
  show: "Series",
  season: "Season",
  episode: "Episode",
} as const satisfies Record<Kind, string>;

const kindsByType = new Map<string, Kind>(
  Object.entries(itemTypes).map(([kind, type]) => [
    type.toLowerCase(),
    kind as Kind,
  ]),
);

const collectionTypes = { movies: "movies", shows: "tvshows" } as const;

// Jellyfin's ItemSortBy names, lowercased, for the orders Pendia can serve.
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

function userData(view: ItemView) {
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
  const playable = view.kind === "movie" || view.kind === "episode";
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
function libraryDto(library: Library, serverId: string) {
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

function guids(values: string[]) {
  return values.flatMap((value) => parseGuid(value) ?? []);
}

/** Reads IncludeItemTypes and ExcludeItemTypes. Undefined means every kind. */
function kindsOf(query: Query): Kind[] | undefined {
  const include = query.list("includeItemTypes");
  const exclude = new Set(
    query.list("excludeItemTypes").map((type) => type.toLowerCase()),
  );
  if (include.length === 0 && exclude.size === 0) return undefined;
  const named =
    include.length === 0
      ? Object.values(itemTypes)
      : include.flatMap((type) => {
          const kind = kindsByType.get(type.toLowerCase());
          return kind === undefined ? [] : [itemTypes[kind]];
        });
  return named
    .filter((type) => !exclude.has(type.toLowerCase()))
    .flatMap((type) => kindsByType.get(type.toLowerCase()) ?? []);
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

async function viewsResult({ db, caller }: UserContext, query: ItemViewQuery) {
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

// Shelves hand back ordered ids; the views keep that order and then page.
async function shelfResult(
  context: UserContext,
  ids: string[],
  keep: (view: ItemView) => boolean = () => true,
) {
  const { db, caller, query } = context;
  const kinds = kindsOf(query);
  const [page, serverId] = await Promise.all([
    listItemViews(db, caller.user.id, { ids, kinds }),
    readServerId(db),
  ]);
  const byId = new Map(page.items.map((view) => [view.id, view]));
  const views = ids.flatMap((id) => byId.get(id) ?? []).filter(keep);
  const { offset, limit } = pageOf(query);
  const shown = views.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  );
  return json(
    queryResult(
      shown.map((view) => baseItemDto(view, serverId)),
      views.length,
      offset,
    ),
  );
}

function requiredGuid(text: string | undefined) {
  const id = text === undefined ? undefined : parseGuid(text);
  if (id === undefined) throw new AuthError("NOT_FOUND");
  return id;
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
    handle: async ({ db, caller }) => {
      const [libraries, serverId] = await Promise.all([
        viewableLibraries(db, caller.user.id),
        readServerId(db),
      ]);
      return json(
        queryResult(
          libraries.map((library) => libraryDto(library, serverId)),
          libraries.length,
          0,
        ),
      );
    },
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
      if (kinds?.length === 0)
        return json(queryResult([], 0, pageOf(query).offset));
      return viewsResult(context, {
        ...(library !== undefined
          ? { libraryIds: [library.id], parentId: recursive ? undefined : null }
          : recursive
            ? { ancestorId: parentId }
            : { parentId }),
        ids: ids.length === 0 ? undefined : guids(ids),
        kinds,
        search: query.get("searchTerm"),
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
      if (view === undefined) throw new AuthError("NOT_FOUND");
      return json(baseItemDto(view, serverId));
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
      const series = context.query.get("seriesId");
      const showId = series === undefined ? undefined : requiredGuid(series);
      return shelfResult(
        context,
        await nextUp(context.db, context.caller.user.id),
        (view) => showId === undefined || view.show?.id === showId,
      );
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
      });
    },
  },
];
