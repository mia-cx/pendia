import {
  countItemKinds,
  type ItemViewQuery,
  listContributorCredits,
  listItemViews,
  listLibraryFacets,
  viewableLibraries,
} from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { readAccount, readClientPreference } from "../auth/profile.ts";
import { readServerId } from "../server-id.ts";
import { facetId } from "./facets.ts";
import { json, type Route, type UserContext } from "./http.ts";
import {
  baseItemDto,
  browseSelection,
  libraryDto,
  viewsResult,
} from "./items.ts";
import { requiredGuid, ticksPerSecond, toGuid } from "./request.ts";

/** Reads use the requested user's library permissions; only administrators may browse for someone else. */
export function browseAsUser(route: Route): Route {
  if (route.anonymous) return route;
  return {
    ...route,
    handle: async (context) => {
      const requested = context.query.get("userId");
      if (requested === undefined) return route.handle(context);
      const userId = requiredGuid(requested);
      if (userId === context.caller.user.id) return route.handle(context);
      const user = await readAccount(
        context.db,
        context.caller.user.id,
        userId,
      );
      return route.handle({ ...context, caller: { ...context.caller, user } });
    },
  };
}

function matches(name: string, context: UserContext) {
  const query = context.query;
  const lower = name.toLowerCase();
  const search = query.get("searchTerm")?.toLowerCase();
  const starts = query.get("nameStartsWith")?.toLowerCase();
  const less = query.get("nameLessThan")?.toLowerCase();
  const greater = query.get("nameStartsWithOrGreater")?.toLowerCase();
  return (
    (search === undefined || lower.includes(search)) &&
    (starts === undefined || lower.startsWith(starts)) &&
    (less === undefined || lower < less) &&
    (greater === undefined || lower >= greater)
  );
}

function page<T>(items: T[], context: UserContext) {
  const offset = context.query.count("startIndex") ?? 0;
  const limit = context.query.count("limit");
  return {
    Items: items.slice(
      offset,
      limit === undefined ? undefined : offset + limit,
    ),
    TotalRecordCount: items.length,
    StartIndex: offset,
  };
}

async function selection(context: UserContext): Promise<ItemViewQuery> {
  const {
    offset: _offset,
    limit: _limit,
    ...query
  } = await browseSelection(context);
  return query;
}

async function facets(context: UserContext, identities = false) {
  const {
    search: _search,
    nameStartsWith: _starts,
    nameLessThan: _less,
    nameStartsWithOrGreater: _greater,
    ...query
  } = await selection(context);
  return listLibraryFacets(
    context.db,
    context.caller.user.id,
    identities ? { ...query, kinds: undefined } : query,
  );
}

async function names(
  context: UserContext,
  type: "Genre" | "Year",
  identities = false,
) {
  const values = await facets(context, identities);
  const entries = type === "Genre" ? values.genres : values.years.map(String);
  return entries
    .filter((name) => matches(name, context))
    .map((name) => ({
      Id: facetId(type, name),
      Name: name,
      Type: type,
      IsFolder: true,
      ImageTags: {},
      BackdropImageTags: [],
    }));
}

async function people(context: UserContext, identities = false) {
  const {
    search: _search,
    nameStartsWith: _starts,
    nameLessThan: _less,
    nameStartsWithOrGreater: _greater,
    ...query
  } = await selection(context);
  const itemId = context.query.get("appearsInItemId");
  const rows = await listContributorCredits(
    context.db,
    context.caller.user.id,
    {
      ...query,
      kinds: identities ? undefined : query.kinds,
      ids: itemId === undefined ? query.ids : [requiredGuid(itemId)],
    },
  );
  const includes = context.query
    .list("personTypes")
    .map((type) => type.toLowerCase());
  const excludes = context.query
    .list("excludePersonTypes")
    .map((type) => type.toLowerCase());
  const matching = rows.filter(
    (person) =>
      matches(person.name, context) &&
      (!includes.length || includes.includes(person.role.toLowerCase())) &&
      !excludes.includes(person.role.toLowerCase()),
  );
  return [
    ...new Map(
      matching.map((person) => [
        person.id,
        {
          Id: toGuid(person.id),
          Name: person.name,
          Overview: person.overview,
          Type: "Person",
          IsFolder: true,
          ImageTags: {},
          BackdropImageTags: [],
        },
      ]),
    ).values(),
  ];
}

/** Core-backed browse facets, search, shelves, and metadata identities for Jellyfin clients. */
export const additionalBrowseRoutes: Route[] = [
  {
    method: "GET",
    path: "/UserViews/GroupingOptions",
    handle: async ({ db, caller }) =>
      json(
        (await viewableLibraries(db, caller.user.id)).map((library) => ({
          Id: toGuid(library.id),
          Name: library.name,
        })),
      ),
  },
  {
    method: "GET",
    path: "/Library/MediaFolders",
    handle: async (context) => {
      const serverId = await readServerId(context.db);
      return json(
        page(
          (await viewableLibraries(context.db, context.caller.user.id)).map(
            (library) => libraryDto(library, serverId),
          ),
          context,
        ),
      );
    },
  },
  {
    method: "GET",
    path: "/Items/Root",
    handle: async ({ db, caller }) => {
      const serverId = await readServerId(db);
      return json({
        Id: facetId("Folder", serverId),
        ServerId: toGuid(serverId),
        Name: "Media",
        Type: "Folder",
        IsFolder: true,
        ChildCount: (await viewableLibraries(db, caller.user.id)).length,
      });
    },
  },
  {
    method: "GET",
    path: "/Items/Latest",
    handle: async (context) => {
      const query = await browseSelection(context);
      const serverId = await readServerId(context.db);
      const stored = await readClientPreference(
        context.db,
        context.caller.user.id,
        context.caller.user.id,
        "jellyfin",
        "configuration",
      );
      const hidePlayed =
        stored !== null && typeof stored === "object" && !Array.isArray(stored)
          ? stored.HidePlayedInLatest !== false
          : true;
      const rows = await listItemViews(context.db, context.caller.user.id, {
        ...query,
        kinds: query.kinds ?? ["movie", "show"],
        played:
          context.query.flag("isPlayed") ?? (hidePlayed ? false : undefined),
        sort: [{ by: "added", descending: true }],
        limit: query.limit ?? 20,
      });
      return json(rows.items.map((item) => baseItemDto(item, serverId)));
    },
  },
  {
    method: "GET",
    path: "/Items/Counts",
    handle: async (context) => {
      const counts = await countItemKinds(
        context.db,
        context.caller.user.id,
        await selection(context),
      );
      return json({
        MovieCount: counts.find((row) => row.kind === "movie")?.total ?? 0,
        SeriesCount: counts.find((row) => row.kind === "show")?.total ?? 0,
        EpisodeCount: counts.find((row) => row.kind === "episode")?.total ?? 0,
        ItemCount: counts.reduce((total, row) => total + row.total, 0),
        ArtistCount: 0,
        ProgramCount: 0,
        TrailerCount: 0,
        SongCount: 0,
        AlbumCount: 0,
        MusicVideoCount: 0,
        BoxSetCount: 0,
        BookCount: 0,
      });
    },
  },
  {
    method: "GET",
    path: "/Items/{itemId}/Ancestors",
    handle: async (context) => {
      const { db, caller, params } = context;
      const serverId = await readServerId(db);
      const result: ReturnType<typeof baseItemDto | typeof libraryDto>[] = [];
      let [item] = (
        await listItemViews(db, caller.user.id, {
          ids: [requiredGuid(params.itemId)],
        })
      ).items;
      if (item === undefined) throw new AuthError("NOT_FOUND");
      const libraryId = item.libraryId;
      while (item?.parentId != null) {
        [item] = (
          await listItemViews(db, caller.user.id, { ids: [item.parentId] })
        ).items;
        if (item !== undefined) result.push(baseItemDto(item, serverId));
      }
      const library = (await viewableLibraries(db, caller.user.id)).find(
        (row) => row.id === libraryId,
      );
      if (library !== undefined) result.push(libraryDto(library, serverId));
      return json(result);
    },
  },
  ...(
    [
      "/Items/{itemId}/Similar",
      "/Movies/{itemId}/Similar",
      "/Shows/{itemId}/Similar",
    ] as const
  ).map(
    (path): Route => ({
      method: "GET",
      path,
      handle: async (context) => {
        const id = requiredGuid(context.params.itemId);
        const [baseline] = (
          await listItemViews(context.db, context.caller.user.id, { ids: [id] })
        ).items;
        if (baseline === undefined) throw new AuthError("NOT_FOUND");
        return viewsResult(context, {
          ...(await browseSelection(context)),
          kinds: [baseline.kind],
          genres: baseline.genres.length ? baseline.genres : undefined,
          excludeIds: [id],
          limit: context.query.count("limit") ?? 20,
        });
      },
    }),
  ),
  {
    method: "GET",
    path: "/Items/Suggestions",
    handle: async (context) => {
      const query = await browseSelection(context);
      return viewsResult(context, {
        ...query,
        kinds: query.kinds ?? ["movie", "episode"],
        played: false,
        sort: [{ by: "added", descending: true }],
        limit: context.query.count("limit") ?? 20,
      });
    },
  },
  {
    method: "GET",
    path: "/Shows/Upcoming",
    handle: async (context) =>
      viewsResult(context, {
        ...(await browseSelection(context)),
        kinds: ["episode"],
        premiereAfter: new Date().toISOString().slice(0, 10),
        sort: [{ by: "premiere" }],
        limit: context.query.count("limit") ?? 20,
      }),
  },
  {
    method: "GET",
    path: "/Movies/Recommendations",
    handle: async (context) => {
      if (context.query.count("categoryLimit") === 0) return json([]);
      const query = await browseSelection(context);
      const serverId = await readServerId(context.db);
      const [baseline] = (
        await listItemViews(context.db, context.caller.user.id, {
          ...query,
          kinds: ["movie"],
          sort: [{ by: "played", descending: true }],
          limit: 1,
        })
      ).items;
      const rows = await listItemViews(context.db, context.caller.user.id, {
        ...query,
        kinds: ["movie"],
        genres: baseline?.genres.length ? baseline.genres : undefined,
        excludeIds: baseline === undefined ? undefined : [baseline.id],
        limit: context.query.count("itemLimit") ?? 10,
      });
      return json(
        rows.items.length
          ? [
              {
                Items: rows.items.map((item) => baseItemDto(item, serverId)),
                RecommendationType: "SimilarToRecentlyPlayed",
                BaselineItemName: baseline?.title ?? "",
                CategoryId: facetId("Recommendation", baseline?.id ?? "movies"),
              },
            ]
          : [],
      );
    },
  },
  ...(["Genre", "Year"] as const).flatMap((type) => [
    {
      method: "GET" as const,
      path: type === "Genre" ? "/Genres" : "/Years",
      handle: async (context: UserContext) =>
        json(page(await names(context, type), context)),
    },
    {
      method: "GET" as const,
      path: type === "Genre" ? "/Genres/{genreName}" : "/Years/{year}",
      handle: async (context: UserContext) => {
        const name = context.params.genreName ?? context.params.year;
        const item = (await names(context, type)).find(
          (item) => item.Name === name,
        );
        if (item === undefined) throw new AuthError("NOT_FOUND");
        return json(item);
      },
    },
  ]),
  {
    method: "GET",
    path: "/Persons",
    handle: async (context) => json(page(await people(context), context)),
  },
  {
    method: "GET",
    path: "/Persons/{name}",
    handle: async (context) => {
      const person = (await people(context)).find(
        (person) =>
          person.Name === context.params.name ||
          person.Id === toGuid(context.params.name ?? ""),
      );
      if (person === undefined) throw new AuthError("NOT_FOUND");
      return json(person);
    },
  },
  {
    method: "GET",
    path: "/Items/Filters",
    handle: async (context) => {
      const values = await facets(context);
      return json({
        Genres: values.genres,
        Tags: values.tags,
        Years: values.years,
        OfficialRatings: values.ratings,
      });
    },
  },
  {
    method: "GET",
    path: "/Items/Filters2",
    handle: async (context) => {
      const values = await facets(context);
      return json({
        Genres: values.genres.map((Name) => ({
          Name,
          Id: facetId("Genre", Name),
        })),
        Tags: values.tags,
        AudioLanguages: values.audioLanguages.map((Name) => ({
          Name,
          Value: Name,
        })),
        SubtitleLanguages: values.subtitleLanguages.map((Name) => ({
          Name,
          Value: Name,
        })),
      });
    },
  },
  {
    method: "GET",
    path: "/Search/Hints",
    handle: async (context) => {
      const query = await browseSelection(context);
      const serverId = await readServerId(context.db);
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      const rows =
        context.query.flag("includeMedia") === false
          ? { items: [], total: 0 }
          : await listItemViews(context.db, context.caller.user.id, {
              ...query,
              offset: undefined,
              limit: offset + limit,
            });
      const hints: object[] = rows.items.map((item) => {
        const {
          Id,
          Name,
          Type,
          ProductionYear,
          IndexNumber,
          ParentIndexNumber,
          IsFolder,
          MediaType,
          SeriesName: Series,
          Status,
        } = baseItemDto(item, serverId);
        return {
          Id,
          Name,
          Type,
          ProductionYear,
          IndexNumber,
          ParentIndexNumber,
          IsFolder,
          MediaType,
          Series,
          Status,
          ItemId: toGuid(item.id),
          MatchedTerm: item.title,
          RunTimeTicks: Math.round(
            (item.durationSeconds ?? 0) * ticksPerSecond,
          ),
          PrimaryImageTag:
            item.artwork.poster === null
              ? undefined
              : toGuid(item.artwork.poster),
        };
      });
      const mediaCount = hints.length;
      // Search restricts the returned identity type, not the media carrying its credits or genres.
      const includes = context.query
        .list("includeItemTypes")
        .map((type) => type.toLowerCase());
      const excludes = context.query
        .list("excludeItemTypes")
        .map((type) => type.toLowerCase());
      const mediaTypes = context.query
        .list("mediaTypes")
        .map((type) => type.toLowerCase());
      // Person and Genre identities have Unknown media type and are neither movies nor series.
      const allowed = (type: string) =>
        (!includes.length || includes.includes(type)) &&
        !excludes.includes(type) &&
        context.query.flag("isMovie") !== true &&
        context.query.flag("isSeries") !== true &&
        (!mediaTypes.length || mediaTypes.includes("unknown"));
      if (context.query.flag("includePeople") !== false && allowed("person"))
        hints.push(
          ...(await people(context, true)).map((person) => ({
            Id: person.Id,
            ItemId: person.Id,
            Name: person.Name,
            MatchedTerm: person.Name,
            Type: "Person",
            MediaType: "Unknown",
            IsFolder: true,
          })),
        );
      if (context.query.flag("includeGenres") !== false && allowed("genre"))
        hints.push(
          ...(await names(context, "Genre", true)).map((genre) => ({
            Id: genre.Id,
            ItemId: genre.Id,
            Name: genre.Name,
            MatchedTerm: genre.Name,
            Type: "Genre",
            MediaType: "Unknown",
            IsFolder: true,
          })),
        );
      const paged = page(hints, context);
      return json({
        SearchHints: paged.Items.slice(0, limit),
        TotalRecordCount: rows.total + hints.length - mediaCount,
      });
    },
  },
];
