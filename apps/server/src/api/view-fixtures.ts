import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  artwork,
  favourites,
  libraryAccess,
  progress,
  providerIds,
  ratings,
  versions,
} from "../db/schema/index.ts";
import { insertItem } from "../db/tree.ts";
import { insertLibraries } from "../libraries/testing.ts";

async function library(db: Database, name: string, medium: "movies" | "shows") {
  const [row] = await insertLibraries(db, {
    name,
    medium,
    rootPath: `/srv/${name}`,
  });
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

/**
 * Migrates and seeds a browse test: Movies, Shows and a Private library the
 * viewer may not see, a Show with two Seasons, artwork, provider ids, and the
 * viewer's progress, favourite and rating.
 */
export async function seedBrowse(db: Database) {
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
  const seasonTwo = await insertItem(db, {
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
    hidden,
    matrix,
    arrival,
    heat,
    secret,
    show,
    seasonOne,
    seasonTwo,
    episodeOne,
    episodeTwo,
    poster,
    showPoster,
  };
}
