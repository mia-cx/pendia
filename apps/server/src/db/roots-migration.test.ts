import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Database } from "./client.ts";
import { migrateDatabase } from "./migrate.ts";
import { databaseUrl, withDatabase } from "./testing.ts";

const rootsMigration = "0016_library_roots";
const drizzleFolder = new URL("../../drizzle", import.meta.url).pathname;

/** Applies every migration before the roots migration. */
async function migrateBeforeRoots(db: Database) {
  const folder = await mkdtemp(join(tmpdir(), "pendia-migrations-"));
  try {
    await cp(drizzleFolder, folder, { recursive: true });
    const journalPath = join(folder, "meta/_journal.json");
    const journal: { entries: { tag: string }[] } =
      await Bun.file(journalPath).json();
    const cut = journal.entries.findIndex(
      (entry) => entry.tag === rootsMigration,
    );
    if (cut < 0) throw new Error("The roots migration is missing.");
    journal.entries = journal.entries.slice(0, cut);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const id = () => Bun.randomUUIDv7();

/** Seeds the single-root schema with a movie and a show, each with Files, progress and artwork, and a stored Version of the movie. */
async function seedSingleRoots(db: Database) {
  const ids = {
    movies: id(),
    shows: id(),
    user: id(),
    movie: id(),
    timeline: id(),
    movieVersion: id(),
    movieFile: id(),
    stored: id(),
    show: id(),
    season: id(),
    episode: id(),
    episodeVersion: id(),
    episodeFile: id(),
    job: id(),
  };
  const moviePath = "Movie (2020)/Movie (2020).mkv";
  const episodePath = "Show/Season 01/Show S01E01.mkv";
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into libraries (id, name, medium, root_path) values
        (${ids.movies}, 'Movies', 'movies', '/srv/movies'),
        (${ids.shows}, 'Shows', 'shows', '/srv/shows')`);
    await tx.execute(sql`
      insert into users (id, username, display_name, password_hash)
      values (${ids.user}, 'mia', 'Mia', 'hash')`);
    await tx.execute(sql`
      insert into items (id, library_id, kind, title, canonical_folder) values
        (${ids.movie}, ${ids.movies}, 'movie', 'Movie', 'Movie (2020)'),
        (${ids.show}, ${ids.shows}, 'show', 'Show', 'Show')`);
    await tx.execute(sql`
      insert into items (id, library_id, kind, parent_id, title, canonical_folder)
      values (${ids.season}, ${ids.shows}, 'season', ${ids.show}, 'Season 1', 'Show/Season 01')`);
    await tx.execute(sql`
      insert into items (id, library_id, kind, parent_id, title, canonical_folder)
      values (${ids.episode}, ${ids.shows}, 'episode', ${ids.season}, 'Episode 1', 'Show/Season 01')`);
    await tx.execute(sql`insert into movies (item_id) values (${ids.movie})`);
    await tx.execute(sql`insert into shows (item_id) values (${ids.show})`);
    await tx.execute(sql`
      insert into seasons (item_id, show_id, season_number)
      values (${ids.season}, ${ids.show}, 1)`);
    await tx.execute(sql`
      insert into episodes (item_id, season_id, episode_number)
      values (${ids.episode}, ${ids.season}, 1)`);
    await tx.execute(sql`
      insert into segment_timelines (id, item_id, cut_key, boundaries_seconds)
      values (${ids.timeline}, ${ids.movie}, 'cut', '{0,3,6}')`);
    await tx.execute(sql`
      insert into versions (id, item_id, item_kind, library_id, label, format, bytes, segment_timeline_id, timeline_aligned) values
        (${ids.movieVersion}, ${ids.movie}, 'movie', ${ids.movies}, '720p', 'video', 10, ${ids.timeline}, true),
        (${ids.episodeVersion}, ${ids.episode}, 'episode', ${ids.shows}, '1080p', 'video', 20, null, false)`);
    await tx.execute(sql`
      insert into files (id, version_id, item_id, library_id, path, "order", bytes, modified_at) values
        (${ids.movieFile}, ${ids.movieVersion}, ${ids.movie}, ${ids.movies}, ${moviePath}, 0, 10, now()),
        (${ids.episodeFile}, ${ids.episodeVersion}, ${ids.episode}, ${ids.shows}, ${episodePath}, 0, 20, now())`);
    await tx.execute(sql`
      insert into versions (id, item_id, item_kind, library_id, label, format, bytes, segment_timeline_id, timeline_aligned, origin, source_file_id, stored_folder, rung, complete)
      values (${ids.stored}, ${ids.movie}, 'movie', ${ids.movies}, '360p', 'video', 5, ${ids.timeline}, true, 'stored', ${ids.movieFile}, ${`${moviePath}.pendia/360p`}, '360p', true)`);
    await tx.execute(sql`
      insert into progress (id, user_id, item_id, version_id, format, position_seconds) values
        (${id()}, ${ids.user}, ${ids.movie}, ${ids.movieVersion}, 'video', 42),
        (${id()}, ${ids.user}, ${ids.episode}, ${ids.episodeVersion}, 'video', 7)`);
    await tx.execute(sql`
      insert into artwork (id, item_id, type, backend, storage_key, selected) values
        (${id()}, ${ids.movie}, 'poster', 'colocated', 'Movie (2020)/.pendia/artwork/poster.jpg', true),
        (${id()}, ${ids.show}, 'poster', 'colocated', 'Show/.pendia/artwork/poster.jpg', true)`);
    await tx.execute(sql`
      insert into probe_cache (id, library_id, path, bytes, modified_ns, result) values
        (${id()}, ${ids.movies}, ${moviePath}, 10, 1, '{}'),
        (${id()}, ${ids.shows}, ${episodePath}, 20, 1, '{}')`);
    await tx.execute(sql`
      insert into jobs (id, type, payload, max_attempts, concurrency_key) values
        (${ids.job}, 'scan', ${JSON.stringify({
          type: "scan",
          libraryId: ids.shows,
          path: "Show",
          changes: [{ kind: "add", path: episodePath, providerIds: {} }],
        })}::text::jsonb, 3, ${`library:${ids.shows}`})`);
  });
  return ids;
}

const count = async (db: Database, table: string) => {
  const [row] = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from ${sql.identifier(table)}`,
  );
  return row?.count;
};

describe.skipIf(!databaseUrl)("The library roots migration", () => {
  test("gives each Library one root and points its Files and probes there", () =>
    withDatabase(async (db) => {
      await migrateBeforeRoots(db);
      const ids = await seedSingleRoots(db);
      const tables = [
        "libraries",
        "items",
        "versions",
        "files",
        "progress",
        "artwork",
        "segment_timelines",
        "probe_cache",
        "jobs",
      ];
      const before = await Promise.all(tables.map((table) => count(db, table)));

      await migrateDatabase(db);

      expect(
        await Promise.all(tables.map((table) => count(db, table))),
      ).toEqual(before);
      const roots = await db.execute<{
        id: string;
        libraryId: string;
        path: string;
        position: number;
      }>(
        sql`select id, library_id as "libraryId", path, position from library_roots order by path`,
      );
      expect(roots.map(({ id: _, ...root }) => root)).toEqual([
        { libraryId: ids.movies, path: "/srv/movies", position: 0 },
        { libraryId: ids.shows, path: "/srv/shows", position: 0 },
      ]);
      const rootOf = new Map(roots.map((root) => [root.libraryId, root.id]));
      const files = await db.execute<{ id: string; rootId: string }>(
        sql`select id, root_id as "rootId" from files order by id`,
      );
      expect(new Map(files.map((file) => [file.id, file.rootId]))).toEqual(
        new Map([
          [ids.movieFile, rootOf.get(ids.movies)],
          [ids.episodeFile, rootOf.get(ids.shows)],
        ]),
      );
      const probes = await db.execute<{ path: string; rootId: string }>(
        sql`select path, root_id as "rootId" from probe_cache order by path`,
      );
      expect(probes.map((probe) => probe.rootId)).toEqual([
        rootOf.get(ids.movies),
        rootOf.get(ids.shows),
      ]);
      const [stored] = await db.execute<{ sourceFileId: string }>(
        sql`select source_file_id as "sourceFileId" from versions where id = ${ids.stored}`,
      );
      expect(stored?.sourceFileId).toBe(ids.movieFile);
      const [job] = await db.execute<{ rootIds: string[] }>(
        sql`select array(select change->>'rootId' from jsonb_array_elements(payload->'changes') as change) as "rootIds" from jobs where id = ${ids.job}`,
      );
      expect(job?.rootIds).toEqual([rootOf.get(ids.shows)]);
    }));

  test("stops with the shared root when two Libraries use one root", () =>
    withDatabase(async (db) => {
      await migrateBeforeRoots(db);
      await db.execute(sql`
        insert into libraries (id, name, medium, root_path) values
          (${id()}, 'Movies', 'movies', '/srv/media'),
          (${id()}, 'Shows', 'shows', '/srv/media')`);
      const failure = await migrateDatabase(db).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        cause: {
          message: expect.stringContaining(
            "Several libraries use the root /srv/media.",
          ),
        },
      });
    }));
});
