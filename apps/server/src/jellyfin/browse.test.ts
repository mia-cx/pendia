import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedBrowse } from "../api/view-fixtures.ts";
import {
  contributors,
  credits,
  files,
  items,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJellyfinHandler } from "./http.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { jellyfinLogin } from "./testing.ts";

describe.skipIf(!databaseUrl)("Jellyfin browse facets", () => {
  test("keeps facets, people, and search inside authorized libraries and filters by stable facet identifiers", () =>
    withDatabase(async (db) => {
      const seed = await seedBrowse(db);
      const [version] = await db
        .select()
        .from(versions)
        .where(eq(versions.itemId, seed.matrix.id));
      if (version === undefined) throw new Error("Missing version");
      const [file] = await db
        .insert(files)
        .values({
          versionId: version.id,
          itemId: seed.matrix.id,
          libraryId: seed.films.id,
          rootId: seed.films.rootId,
          path: "The Matrix/movie.mp4",
          order: 0,
          bytes: 1n,
          modifiedAt: new Date(),
        })
        .returning();
      if (file === undefined) throw new Error("Missing file");
      await db.insert(streams).values([
        {
          versionId: version.id,
          fileId: file.id,
          index: 0,
          kind: "audio",
          codec: "aac",
          language: "eng",
        },
        {
          versionId: version.id,
          fileId: file.id,
          index: 1,
          kind: "subtitle",
          codec: "subrip",
          language: "nld",
        },
      ]);
      await db
        .update(items)
        .set({ genres: ["Science Fiction"], tags: ["Classic"] })
        .where(eq(items.id, seed.matrix.id));
      await db
        .update(items)
        .set({ genres: ["Private genre"], tags: ["Private tag"] })
        .where(eq(items.id, seed.secret.id));
      const [actor] = await db
        .insert(contributors)
        .values({ name: "Keanu Reeves" })
        .returning();
      const [hiddenActor] = await db
        .insert(contributors)
        .values({ name: "Private actor" })
        .returning();
      if (actor === undefined || hiddenActor === undefined)
        throw new Error("Missing contributors");
      await db.insert(credits).values([
        {
          itemId: seed.matrix.id,
          contributorId: actor.id,
          role: "actor",
          character: "Neo",
          order: 0,
        },
        {
          itemId: seed.secret.id,
          contributorId: hiddenActor.id,
          role: "actor",
          order: 0,
        },
      ]);
      const handle = createJellyfinHandler(
        db,
        jellyfinRoutes(
          async () => new Response(),
          async () => new Response(),
        ),
      );
      const token = await jellyfinLogin(
        (request) => handle(request, "127.0.0.1"),
        'MediaBrowser Client="Browse", Device="Browser", DeviceId="browse"',
      );
      const admin = await jellyfinLogin(
        (request) => handle(request, "127.0.0.1"),
        'MediaBrowser Client="Browse", Device="Browser", DeviceId="browse-admin"',
        "admin",
        "admin-pass",
      );
      const call = async (path: string, credential = token) => {
        const response = await handle(
          new Request(`http://thalia.test${path}`, {
            headers: { "X-Emby-Token": credential },
          }),
          "127.0.0.1",
        );
        expect(response?.status, path).toBe(200);
        if (response === undefined) throw new Error("Missing route");
        return response.json();
      };
      const genres = (await call("/Genres")) as {
        Items: { Id: string; Name: string }[];
      };
      expect(genres.Items.map((item) => item.Name)).toEqual([
        "Science Fiction",
      ]);
      const genre = genres.Items[0];
      if (genre === undefined) throw new Error("Missing genre");
      expect(await call(`/Items/${genre.Id}`)).toMatchObject({
        Name: genre.Name,
        Type: "Genre",
      });
      const filtered = (await call(
        `/Items?recursive=true&genreIds=${genre.Id}&years=1999&tags=Classic`,
      )) as { Items: { Name: string }[] };
      expect(filtered.Items.map((item) => item.Name)).toEqual(["The Matrix"]);
      expect(
        await call(
          `/Items?recursive=true&genreIds=${toGuid(Bun.randomUUIDv7())}`,
        ),
      ).toMatchObject({ TotalRecordCount: 0, Items: [] });
      for (const filter of [
        "audioLanguages=eng",
        "subtitleLanguages=nld",
        "hasTmdbId=true",
        "hasImdbId=true",
      ])
        expect(
          await call(`/Items?recursive=true&includeItemTypes=Movie&${filter}`),
        ).toMatchObject({
          TotalRecordCount: 1,
          Items: [{ Name: "The Matrix" }],
        });
      for (const filter of ["audioLanguages=nld", "subtitleLanguages=eng"])
        expect(
          await call(`/Items?recursive=true&includeItemTypes=Movie&${filter}`),
        ).toMatchObject({ TotalRecordCount: 0, Items: [] });
      for (const filter of ["hasTmdbId=false", "hasImdbId=false"])
        expect(
          await call(`/Items?recursive=true&includeItemTypes=Movie&${filter}`),
        ).toMatchObject({
          TotalRecordCount: 2,
          Items: [{ Name: "Arrival" }, { Name: "Heat" }],
        });
      expect(
        await call(
          "/Items?recursive=true&includeItemTypes=Movie&hasTvdbId=false",
        ),
      ).toMatchObject({ TotalRecordCount: 3 });
      expect(
        await call(`/Items?recursive=true&personIds=${toGuid(actor.id)}`),
      ).toMatchObject({ TotalRecordCount: 1, Items: [{ Name: "The Matrix" }] });
      expect(await call("/Persons?searchTerm=Keanu")).toMatchObject({
        TotalRecordCount: 1,
        Items: [{ Name: "Keanu Reeves" }],
      });
      expect(await call("/Search/Hints?searchTerm=Keanu")).toMatchObject({
        TotalRecordCount: 1,
        SearchHints: [{ Name: "Keanu Reeves", Type: "Person" }],
      });
      expect(
        await call("/Search/Hints?searchTerm=Keanu&includeItemTypes=Person"),
      ).toMatchObject({
        TotalRecordCount: 1,
        SearchHints: [{ Type: "Person" }],
      });
      expect(
        await call("/Search/Hints?searchTerm=Science&includeItemTypes=Genre"),
      ).toMatchObject({
        TotalRecordCount: 1,
        SearchHints: [{ Type: "Genre" }],
      });
      expect(
        await call("/Search/Hints?searchTerm=Keanu&excludeItemTypes=Person"),
      ).toMatchObject({ TotalRecordCount: 0, SearchHints: [] });
      expect(
        await call(
          "/Search/Hints?searchTerm=Private&includeItemTypes=Genre,Person",
        ),
      ).toMatchObject({ TotalRecordCount: 0, SearchHints: [] });
      expect(await call("/Items/Filters2")).toMatchObject({
        AudioLanguages: [{ Value: "eng" }],
        SubtitleLanguages: [{ Value: "nld" }],
      });
      expect(await call("/Search/Hints?searchTerm=Private")).toMatchObject({
        TotalRecordCount: 0,
        SearchHints: [],
      });
      expect(await call("/Items/Filters")).toMatchObject({
        Genres: ["Science Fiction"],
        Tags: ["Classic"],
        Years: [1995, 1999, 2016],
      });
      expect(await call("/Items/Counts")).toMatchObject({
        MovieCount: 3,
        SeriesCount: 1,
        EpisodeCount: 2,
      });
      expect(
        await call(`/Items/Counts?userId=${seed.viewer.id}`, admin),
      ).toMatchObject({ MovieCount: 3 });
      const denied = await handle(
        new Request(`http://thalia.test/Items/Counts?userId=${seed.admin.id}`, {
          headers: { "X-Emby-Token": token },
        }),
        "127.0.0.1",
      );
      expect(denied?.status).toBe(403);
      expect(await call(`/Items/${toGuid(seed.matrix.id)}`)).toMatchObject({
        People: [{ Name: "Keanu Reeves", Role: "Neo", Type: "Actor" }],
      });
      const ancestors = (await call(
        `/Items/${toGuid(seed.episodeOne.id)}/Ancestors`,
      )) as { Name: string }[];
      expect(ancestors.map((item) => item.Name)).toEqual([
        "Season 1",
        "Severance",
        "Shows",
      ]);
    }));
});
