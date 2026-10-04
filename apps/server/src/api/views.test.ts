import { describe, expect, test } from "bun:test";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  artwork,
  favourites,
  libraries,
  libraryAccess,
  progress,
  providerIds,
  ratings,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import {
  type ItemViewQuery,
  listItemViews,
  viewableLibraries,
} from "./views.ts";

async function library(db: Database, name: string, medium: "movies" | "shows") {
  const [row] = await db
    .insert(libraries)
    .values({ name, medium, rootPath: `/srv/${name}` })
    .returning();
  if (!row) throw new Error("Library insert returned no row.");
  return row;
}

async function movie(
  db: Database,
  libraryId: string,
  title: string,
  year: number,
) {
  return insertItem(db, {
    libraryId,
    kind: "movie",
    title,
    year,
    canonicalFolder: title,
    extension: {},
  });
}

// Two movie libraries, one hidden from the viewer, and a Show with two Seasons.
async function seed(db: Database) {
  await migrateDatabase(db);
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  const films = await library(db, "Movies", "movies");
  const tv = await library(db, "Shows", "shows");
  const hidden = await library(db, "Private", "movies");
  await db
    .insert(libraryAccess)
    .values({ libraryId: hidden.id, userId: viewer.id, allowed: false });

  const matrix = await movie(db, films.id, "The Matrix", 1999);
  const arrival = await movie(db, films.id, "Arrival", 2016);
  const heat = await movie(db, films.id, "Heat", 1995);
  const secret = await movie(db, hidden.id, "Secret", 2020);

  const show = await insertItem(db, {
    libraryId: tv.id,
    kind: "show",
    title: "Severance",
    canonicalFolder: "Severance",
    extension: { firstAirDate: "2022-02-18" },
  });
  const seasonOne = await insertItem(db, {
    libraryId: tv.id,
    kind: "season",
    parentId: show.id,
    title: "Season 1",
    canonicalFolder: "Severance",
    extension: { seasonNumber: 1 },
  });
  await insertItem(db, {
    libraryId: tv.id,
    kind: "season",
    parentId: show.id,
    title: "Season 2",
    canonicalFolder: "Severance",
    extension: { seasonNumber: 2 },
  });
  const episodeTwo = await insertItem(db, {
    libraryId: tv.id,
    kind: "episode",
    parentId: seasonOne.id,
    title: "Half Loop",
    canonicalFolder: "Severance",
    extension: { episodeNumber: 2 },
  });
  const episodeOne = await insertItem(db, {
    libraryId: tv.id,
    kind: "episode",
    parentId: seasonOne.id,
    title: "Good News About Hell",
    canonicalFolder: "Severance",
    extension: { episodeNumber: 1, airDate: "2022-02-18" },
  });

  const [poster, showPoster] = await db
    .insert(artwork)
    .values([
      {
        itemId: matrix.id,
        type: "poster",
        backend: "colocated" as const,
        storageKey: "The Matrix/poster.jpg",
        selected: true,
      },
      {
        itemId: show.id,
        type: "poster",
        backend: "colocated" as const,
        storageKey: "Severance/poster.jpg",
        selected: true,
      },
    ])
    .returning();
  await db.insert(providerIds).values([
    { itemId: matrix.id, provider: "tmdb", value: "603" },
    { itemId: matrix.id, provider: "imdb", value: "tt0133093" },
  ]);
  await db.insert(versions).values({
    itemId: matrix.id,
    itemKind: "movie",
    libraryId: films.id,
    label: "1080p",
    format: "video",
    bytes: 1n,
    durationSeconds: 8160,
  });
  await db.insert(progress).values([
    {
      userId: viewer.id,
      itemId: matrix.id,
      format: "video",
      positionSeconds: 600,
      playedAt: new Date(),
    },
    {
      userId: viewer.id,
      itemId: episodeOne.id,
      format: "video",
      completed: true,
      playCount: 1,
      playedAt: new Date(),
    },
  ]);
  await db.insert(favourites).values({ userId: viewer.id, itemId: heat.id });
  await db
    .insert(ratings)
    .values({ userId: viewer.id, itemId: arrival.id, value: "8.5" });
  if (!poster || !showPoster)
    throw new Error("Artwork insert returned no row.");
  return {
    admin,
    viewer,
    films,
    tv,
    matrix,
    arrival,
    heat,
    secret,
    show,
    seasonOne,
    episodeOne,
    episodeTwo,
    poster,
    showPoster,
  };
}

describe.skipIf(!databaseUrl)("item views", () => {
  test("filters, sorts and pages within the caller's libraries", () =>
    withDatabase(async (db) => {
      const s = await seed(db);
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
    }));

  test("carries medium fields, artwork, provider ids and the caller's marks", () =>
    withDatabase(async (db) => {
      const s = await seed(db);
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
