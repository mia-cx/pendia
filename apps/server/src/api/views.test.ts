import { describe, expect, test } from "bun:test";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { seedBrowse } from "./view-fixtures.ts";
import {
  type ItemViewQuery,
  listItemViews,
  viewableLibraries,
} from "./views.ts";

describe.skipIf(!databaseUrl)("item views", () => {
  test("filters, sorts and pages within the caller's libraries", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const titles = async (query: ItemViewQuery, userId = s.viewer.id) => {
        const page = await listItemViews(db, userId, query);
        return {
          titles: page.items.map((item) => item.title),
          total: page.total,
        };
      };

      expect(await titles({ kinds: ["movie"] })).toEqual({
        titles: ["Arrival", "Heat", "The Matrix"],
        total: 3,
      });
      expect((await titles({ kinds: ["movie"] }, s.admin.id)).total).toBe(4);
      expect(await titles({ ids: [s.secret.id] })).toEqual({
        titles: [],
        total: 0,
      });
      expect(await titles({ libraryIds: [s.tv.id], parentId: null })).toEqual({
        titles: ["Severance"],
        total: 1,
      });
      expect(await titles({ parentId: s.seasonOne.id })).toEqual({
        titles: ["Good News About Hell", "Half Loop"],
        total: 2,
      });
      expect(
        await titles({ ancestorId: s.show.id, kinds: ["season"] }),
      ).toEqual({ titles: ["Season 1", "Season 2"], total: 2 });
      expect(
        (await titles({ ancestorId: s.show.id, kinds: ["episode"] })).titles,
      ).toEqual(["Good News About Hell", "Half Loop"]);
      expect((await titles({ search: "matrx" })).titles).toEqual([
        "The Matrix",
      ]);
      expect(
        await titles({
          kinds: ["movie"],
          sort: [{ by: "title", descending: true }],
          offset: 1,
          limit: 1,
        }),
      ).toEqual({ titles: ["Heat"], total: 3 });
      expect(
        (await titles({ kinds: ["movie"], sort: [{ by: "year" }] })).titles,
      ).toEqual(["Heat", "The Matrix", "Arrival"]);
      expect(
        (await titles({ kinds: ["movie", "show"], sort: [{ by: "premiere" }] }))
          .titles[0],
      ).toBe("Severance");

      await insertItem(db, {
        libraryId: s.films.id,
        kind: "movie",
        title: "2001: A Space Odyssey",
        canonicalFolder: "2001",
        extension: {},
      });
      const movies = { kinds: ["movie" as const] };
      expect(await titles({ ...movies, nameStartsWith: "H" })).toEqual({
        titles: ["Heat"],
        total: 1,
      });
      expect((await titles({ ...movies, nameLessThan: "A" })).titles).toEqual([
        "2001: A Space Odyssey",
      ]);
      expect((await titles({ ...movies, nameLessThan: "b" })).titles).toEqual([
        "2001: A Space Odyssey",
        "Arrival",
      ]);
    }));

  test("carries medium fields, artwork, provider ids and the caller's marks", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const byTitle = async (query: ItemViewQuery) => {
        const page = await listItemViews(db, s.viewer.id, query);
        return new Map(page.items.map((item) => [item.title, item]));
      };

      const films = await byTitle({ kinds: ["movie"] });
      expect(films.get("The Matrix")).toMatchObject({
        year: 1999,
        durationSeconds: 8160,
        providerIds: { tmdb: "603", imdb: "tt0133093" },
        artwork: { poster: s.poster.id, backdrop: null },
        marks: { positionSeconds: 600, completed: false, favourite: false },
      });
      expect(films.get("Heat")?.marks).toMatchObject({
        favourite: true,
        rating: null,
      });
      expect(films.get("Arrival")?.marks.rating).toBe(8.5);

      const episodes = await byTitle({ parentId: s.seasonOne.id });
      expect(episodes.get("Good News About Hell")).toMatchObject({
        kind: "episode",
        seasonNumber: 1,
        episodeNumber: 1,
        seasonId: s.seasonOne.id,
        premiereDate: "2022-02-18",
        show: {
          id: s.show.id,
          title: "Severance",
          artwork: { poster: s.showPoster.id },
        },
        marks: { completed: true, playCount: 1 },
      });
      const shows = await byTitle({ libraryIds: [s.tv.id], parentId: null });
      expect(shows.get("Severance")).toMatchObject({
        childCount: 2,
        premiereDate: "2022-02-18",
      });

      const marked = async (query: ItemViewQuery) => [
        ...(await byTitle(query)).keys(),
      ];
      expect(await marked({ favourite: true })).toEqual(["Heat"]);
      expect(await marked({ resumable: true })).toEqual(["The Matrix"]);
      expect(await marked({ kinds: ["episode"], played: true })).toEqual([
        "Good News About Hell",
      ]);
      expect(await marked({ kinds: ["episode"], played: false })).toEqual([
        "Half Loop",
      ]);

      expect(
        (await viewableLibraries(db, s.viewer.id)).map((row) => row.name),
      ).toEqual(["Movies", "Shows"]);
      expect(await viewableLibraries(db, s.admin.id)).toHaveLength(3);
    }));
});
