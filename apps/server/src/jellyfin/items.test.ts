import { describe, expect, test } from "bun:test";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import type { Database } from "../db/client.ts";
import { progress } from "../db/schema/index.ts";
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

// A Findroid client against the Jellyfin handler, signed in by name.
async function signIn(db: Database, username: string, password: string) {
  const handle = createJellyfinHandler(
    db,
    jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
  );
  const send = async (path: string, header: string, body?: object) => {
    const response = await handle(
      new Request(`http://pendia.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: header, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      "127.0.0.1",
    );
    if (response === undefined) throw new Error(`${path} unrouted`);
    return response;
  };
  const login = (await (
    await send("/Users/AuthenticateByName", findroid, {
      Username: username,
      Pw: password,
    })
  ).json()) as { AccessToken: string; User: { Id: string } };
  const signedIn = `${findroid}, Token="${login.AccessToken}"`;
  const get = async <T = QueryResult>(path: string) => {
    const response = await send(path, signedIn);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  return { send, get, signedIn, userId: login.User.Id };
}

const guid = toGuid;

describe.skipIf(!databaseUrl)("jellyfin browse", () => {
  test("browses movies and shows as Swiftfin and Findroid do", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const { send, get, signedIn, userId } = await signIn(
        db,
        "viewer",
        "viewer-pass",
      );

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

  test("answers the library list, letter picker and home rows clients ask for", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const { get, userId } = await signIn(db, "viewer", "viewer-pass");

      // Findroid lists libraries with a flat, parentless /Items.
      const roots = await get(`/Items?userId=${userId}`);
      expect(conforms(roots)).toEqual(["Movies", "Shows"]);
      expect(roots.Items.map((item) => item.CollectionType)).toEqual([
        "movies",
        "tvshows",
      ]);
      const second = await get("/Items?startIndex=1&limit=1");
      expect(conforms(second)).toEqual(["Shows"]);
      expect(second).toMatchObject({ TotalRecordCount: 2, StartIndex: 1 });

      const grid = `/Items?parentId=${guid(s.films.id)}&recursive=true&includeItemTypes=Movie`;
      expect(conforms(await get(`${grid}&nameStartsWith=h`))).toEqual(["Heat"]);
      expect(conforms(await get(`${grid}&NameLessThan=B`))).toEqual([
        "Arrival",
      ]);

      // Android TV's Continue Listening row asks for audio, which Pendia has none of.
      expect(conforms(await get("/UserItems/Resume?mediaTypes=Audio"))).toEqual(
        [],
      );
      expect(conforms(await get("/UserItems/Resume?mediaTypes=Video"))).toEqual(
        ["The Matrix"],
      );

      // A started next episode stays in Resume when the client asks it to.
      await db.insert(progress).values({
        userId: s.viewer.id,
        itemId: s.episodeTwo.id,
        format: "video",
        positionSeconds: 30,
        playedAt: new Date(),
      });
      const nextUp = `/Shows/NextUp?seriesId=${guid(s.show.id)}`;
      expect(conforms(await get(nextUp))).toEqual(["Half Loop"]);
      expect(conforms(await get(`${nextUp}&enableResumable=false`))).toEqual(
        [],
      );

      // Before any episode is finished, a named Show offers its first one.
      const admin = await signIn(db, "admin", "admin-pass");
      expect(conforms(await admin.get(nextUp))).toEqual([
        "Good News About Hell",
      ]);
      expect(conforms(await admin.get("/Shows/NextUp"))).toEqual([]);

      // Finishing the last episode leaves nothing next, even with E1 unwatched.
      await db.insert(progress).values({
        userId: s.admin.id,
        itemId: s.episodeTwo.id,
        format: "video",
        completed: true,
        playCount: 1,
        playedAt: new Date(),
      });
      expect(conforms(await admin.get(nextUp))).toEqual([]);
    }));
});
