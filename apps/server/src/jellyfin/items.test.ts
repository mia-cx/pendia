import { describe, expect, test } from "bun:test";
import { seedBrowse } from "../api/view-fixtures.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { createJellyfinHandler } from "./http.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { contractErrors } from "./testing.ts";

const findroid =
  'MediaBrowser Client="Findroid", Version="0.15.4", DeviceId="pixel-1", Device="Pixel"';

type Dto = {
  Id: string;
  Name: string;
  UserData?: object;
  [field: string]: unknown;
};
type QueryResult = { Items: Dto[]; TotalRecordCount: number };

// Every BaseItemDto, and its UserItemDataDto when sent, must satisfy the pinned schemas.
function conforms(result: QueryResult) {
  expect(contractErrors("BaseItemDtoQueryResult", result)).toEqual([]);
  for (const item of result.Items)
    if (item.UserData !== undefined)
      expect(contractErrors("UserItemDataDto", item.UserData)).toEqual([]);
  return result.Items.map((item) => item.Name);
}

describe.skipIf(!databaseUrl)("jellyfin browse", () => {
  test("browses movies and shows as Swiftfin and Findroid do", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const handle = createJellyfinHandler(
        db,
        jellyfinRoutes(createArtworkHandler(db)),
      );
      const send = async (path: string, header: string) => {
        const response = await handle(
          new Request(`http://pendia.test${path}`, {
            method: path.startsWith("/Users/Authenticate") ? "POST" : "GET",
            headers: {
              Authorization: header,
              "content-type": "application/json",
            },
            body: path.startsWith("/Users/Authenticate")
              ? JSON.stringify({ Username: "viewer", Pw: "viewer-pass" })
              : undefined,
          }),
          "127.0.0.1",
        );
        if (response === undefined) throw new Error(`${path} unrouted`);
        return response;
      };
      const login = (await (
        await send("/Users/AuthenticateByName", findroid)
      ).json()) as { AccessToken: string; User: { Id: string } };
      const signedIn = `${findroid}, Token="${login.AccessToken}"`;
      const get = async <T = QueryResult>(path: string) => {
        const response = await send(path, signedIn);
        expect(response.status).toBe(200);
        return (await response.json()) as T;
      };
      const userId = login.User.Id;
      const guid = toGuid;

      const views = await get(`/UserViews?userId=${userId}`);
      expect(conforms(views)).toEqual(["Movies", "Shows"]);
      expect(views.Items.map((item) => item.CollectionType)).toEqual([
        "movies",
        "tvshows",
      ]);

      // Swiftfin pages a library grid by name.
      const grid = await get(
        `/Items?userId=${userId}&parentId=${guid(s.films.id)}&includeItemTypes=Movie&recursive=true&sortBy=SortName,ProductionYear&sortOrder=Ascending&startIndex=0&limit=2&fields=Overview`,
      );
      expect(conforms(grid)).toEqual(["Arrival", "Heat"]);
      expect(grid).toMatchObject({ TotalRecordCount: 3, StartIndex: 0 });

      const matrix = await get<Dto>(
        `/Items/${guid(s.matrix.id)}?userId=${userId}`,
      );
      expect(contractErrors("BaseItemDto", matrix)).toEqual([]);
      expect(contractErrors("UserItemDataDto", matrix.UserData)).toEqual([]);
      expect(matrix).toMatchObject({
        Type: "Movie",
        MediaType: "Video",
        ProductionYear: 1999,
        RunTimeTicks: 81_600_000_000,
        ParentId: guid(s.films.id),
        ProviderIds: { Tmdb: "603", Imdb: "tt0133093" },
        ImageTags: { Primary: guid(s.poster.id) },
        UserData: {
          PlaybackPositionTicks: 6_000_000_000,
          Played: false,
          IsFavorite: false,
          ItemId: guid(s.matrix.id),
        },
      });

      const library = await get<Dto>(`/Items/${guid(s.tv.id)}`);
      expect(library).toMatchObject({
        Type: "CollectionFolder",
        Name: "Shows",
      });
      const series = await get(
        `/Items?parentId=${guid(s.tv.id)}&includeItemTypes=Series&recursive=true`,
      );
      expect(conforms(series)).toEqual(["Severance"]);
      expect(series.Items[0]).toMatchObject({
        Type: "Series",
        IsFolder: true,
        ChildCount: 2,
      });

      const seasons = await get(
        `/Shows/${guid(s.show.id)}/Seasons?userId=${userId}`,
      );
      expect(conforms(seasons)).toEqual(["Season 1", "Season 2"]);
      expect(seasons.Items.map((item) => item.IndexNumber)).toEqual([1, 2]);
      const episodes = await get(
        `/Shows/${guid(s.show.id)}/Episodes?seasonId=${guid(s.seasonOne.id)}&userId=${userId}`,
      );
      expect(conforms(episodes)).toEqual(["Good News About Hell", "Half Loop"]);
      expect(episodes.Items[0]).toMatchObject({
        Type: "Episode",
        IndexNumber: 1,
        ParentIndexNumber: 1,
        SeriesId: guid(s.show.id),
        SeriesName: "Severance",
        SeasonId: guid(s.seasonOne.id),
        SeriesPrimaryImageTag: guid(s.showPoster.id),
        UserData: { Played: true, PlayCount: 1 },
      });

      const resume = await get("/UserItems/Resume?mediaTypes=Video&limit=10");
      expect(conforms(resume)).toEqual(["The Matrix"]);
      const next = await get(`/Shows/NextUp?seriesId=${guid(s.show.id)}`);
      expect(conforms(next)).toEqual(["Half Loop"]);
      const favourites = await get(
        "/Items?filters=IsFavorite&recursive=true&includeItemTypes=Movie,Series",
      );
      expect(conforms(favourites)).toEqual(["Heat"]);
      const found = await get("/Items?SearchTerm=matrx&Recursive=true");
      expect(conforms(found)).toEqual(["The Matrix"]);

      // The Private library is denied to the viewer, so it and its Items read as absent.
      const denied = await send(`/Items/${guid(s.secret.id)}`, signedIn);
      expect(denied.status).toBe(404);
      const hidden = await get(
        `/Items?parentId=${guid(s.hidden.id)}&recursive=true`,
      );
      expect(hidden.TotalRecordCount).toBe(0);
      expect((await send("/Items", findroid)).status).toBe(401);
    }));
});
