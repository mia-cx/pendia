import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { sql } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { authenticate, createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  artwork,
  contributors,
  credits,
  items,
  libraries,
  libraryAccess,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { startPendia } from "../index.ts";
import { runApi } from "./errors.ts";
import { getItemDetail, type ListItemsInput, listItemCards } from "./items.ts";
import type { pendiaRouter } from "./router.ts";

function rpcClient(base: string, token: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof pendiaRouter>>(link);
}

async function capture(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("Expected the client call to reject.");
}

async function seedViewer(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  const { token } = await createApiKey(db, viewer.id, "browse");
  return { admin, viewer, token };
}

async function addLibrary(
  db: Database,
  name: string,
  medium: "movies" | "shows" = "movies",
) {
  const [library] = await db
    .insert(libraries)
    .values({ name, medium, rootPath: `/srv/${name}` })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

const sizeOfGeneratedLibrary = 10_000;
const timedRuns = 5;
const gridBudgetMs = 50;

// Bulk rows straight into the tables: the grid reads items and their selected
// poster, so the dataset carries both.
async function generateMovies(db: Database, libraryId: string, count: number) {
  await db.execute(sql`
    insert into items (id, library_id, kind, title, year, canonical_folder, added_at)
    select uuidv7(), ${libraryId}::uuid, 'movie', initcap(md5(n::text)), 1950 + n % 75,
      'movie-' || n, timestamptz '2026-01-01' + n * interval '1 minute'
    from generate_series(1, ${count}) as n
  `);
  await db.execute(sql`
    insert into artwork (id, item_id, type, backend, storage_key, selected)
    select uuidv7(), id, 'poster', 'colocated', canonical_folder || '/poster.jpg', true
    from items where library_id = ${libraryId}::uuid
  `);
  await db.execute(sql`analyze items`);
  await db.execute(sql`analyze artwork`);
}

async function medianMs(run: () => Promise<unknown>) {
  await run();
  const samples: number[] = [];
  for (let index = 0; index < timedRuns; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

describe.skipIf(!databaseUrl)("browse grids", () => {
  test("the title sort pages A to Z without gaps or repeats", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seedViewer(db);
      const library = await addLibrary(db, "Movies");
      const titles = ["Brazil", "alien", "Alien", "Zodiac", "Heat", "Up"];
      await db.insert(items).values(
        titles.map((title, index) => ({
          libraryId: library.id,
          kind: "movie" as const,
          title,
          canonicalFolder: `movie-${index}`,
        })),
      );
      const expected = (
        await db.execute<{ title: string }>(
          sql`select title from items order by title, id`,
        )
      ).map((row) => row.title);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          token,
        );
        const seen: string[] = [];
        let cursor: string | null = null;
        for (;;) {
          const page = await client.items.list({
            kind: "movie",
            sort: "title",
            limit: 4,
            ...(cursor === null ? {} : { cursor }),
          });
          seen.push(...page.items.map((item) => item.title));
          if (page.cursor === null) break;
          cursor = page.cursor;
        }
        expect(seen).toEqual(expected);

        const added = await client.items.list({ limit: 2 });
        const titled = await client.items.list({ sort: "title", limit: 2 });
        if (added.cursor === null || titled.cursor === null)
          throw new Error("Expected a second page.");
        const crossed = [
          capture(client.items.list({ sort: "title", cursor: added.cursor })),
          capture(client.items.list({ sort: "added", cursor: titled.cursor })),
        ];
        for (const error of await Promise.all(crossed))
          expect(error.code).toBe("BAD_REQUEST");
      } finally {
        await server.stop();
      }
    }));

  test(
    `grids answer under ${gridBudgetMs} ms at ${sizeOfGeneratedLibrary} items`,
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const { token } = await seedViewer(db);
        const library = await addLibrary(db, "Movies");
        await generateMovies(db, library.id, sizeOfGeneratedLibrary);
        const caller = await authenticate(db, token);
        const list = (input: ListItemsInput) =>
          runApi(listItemCards(db, caller, input));
        for (const sort of ["added", "title"] as const) {
          const first = await list({ kind: "movie", sort });
          expect(first.items).toHaveLength(24);
          if (first.cursor === null) throw new Error("Expected a cursor.");
          const cursor = first.cursor;
          const firstPageMs = await medianMs(() =>
            list({ kind: "movie", sort }),
          );
          const nextPageMs = await medianMs(() =>
            list({ kind: "movie", sort, cursor }),
          );
          expect(firstPageMs).toBeLessThan(gridBudgetMs);
          expect(nextPageMs).toBeLessThan(gridBudgetMs);
        }
      }),
    60_000,
  );
});

// A Show with Seasons and Episodes inserted out of order, so reads must sort.
async function seedShow(db: Database, libraryId: string) {
  const show = await insertItem(db, {
    libraryId,
    kind: "show",
    title: "Severance",
    canonicalFolder: "Severance",
    extension: {},
  });
  const seasonTwo = await insertItem(db, {
    libraryId,
    kind: "season",
    parentId: show.id,
    title: "Season 2",
    canonicalFolder: "Severance",
    extension: { seasonNumber: 2 },
  });
  const seasonOne = await insertItem(db, {
    libraryId,
    kind: "season",
    parentId: show.id,
    title: "Season 1",
    canonicalFolder: "Severance",
    extension: { seasonNumber: 1 },
  });
  const episodes = [];
  for (const episodeNumber of [3, 1, 2]) {
    episodes[episodeNumber] = await insertItem(db, {
      libraryId,
      kind: "episode",
      parentId: seasonOne.id,
      title: `Episode ${episodeNumber}`,
      canonicalFolder: "Severance",
      extension: { episodeNumber },
    });
  }
  const [poster] = await db
    .insert(artwork)
    .values({
      itemId: show.id,
      type: "poster",
      backend: "colocated",
      storageKey: "Severance/poster.jpg",
      selected: true,
    })
    .returning();
  const first = episodes[1];
  if (!first || !poster) throw new Error("Seeding returned no row.");
  return { show, seasonOne, seasonTwo, first, poster };
}

describe.skipIf(!databaseUrl)("browse details", () => {
  test("a detail lists children, credits and Versions in order", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id);
      const people = await db
        .insert(contributors)
        .values([
          { name: "Ben Stiller" },
          { name: "Adam Scott" },
          { name: "Britt Lower" },
          { name: "Dan Erickson" },
        ])
        .returning();
      const [director, adam, britt, writer] = people;
      if (!director || !adam || !britt || !writer)
        throw new Error("Contributor insert returned no row.");
      await db.insert(credits).values([
        {
          itemId: seeded.first.id,
          contributorId: director.id,
          role: "director",
          order: 0,
        },
        {
          itemId: seeded.first.id,
          contributorId: writer.id,
          role: "writer",
          order: 0,
        },
        {
          itemId: seeded.first.id,
          contributorId: britt.id,
          role: "actor",
          character: "Helly R.",
          order: 1,
        },
        {
          itemId: seeded.first.id,
          contributorId: adam.id,
          role: "actor",
          character: "Mark S.",
          order: 0,
        },
      ]);
      await db.insert(versions).values(
        ["Director's Cut", "Broadcast"].map((label) => ({
          itemId: seeded.first.id,
          itemKind: "episode" as const,
          libraryId: library.id,
          label,
          format: "video" as const,
          bytes: 5_000_000_000n,
          durationSeconds: 3300,
        })),
      );
      const caller = await authenticate(db, token);

      const show = await runApi(getItemDetail(db, caller, seeded.show.id));
      expect(show.children.map((child) => child.seasonNumber)).toEqual([1, 2]);
      expect(show.posterArtworkId).toBe(seeded.poster.id);
      expect(show.show).toBeNull();

      const season = await runApi(
        getItemDetail(db, caller, seeded.seasonOne.id),
      );
      expect(season.show?.id).toBe(seeded.show.id);
      expect(season.children.map((child) => child.episodeNumber)).toEqual([
        1, 2, 3,
      ]);
      expect(season.children[0]).toMatchObject({
        parentId: seeded.seasonOne.id,
        seasonNumber: 1,
        show: {
          id: seeded.show.id,
          title: "Severance",
          posterArtworkId: seeded.poster.id,
        },
      });

      const episode = await runApi(getItemDetail(db, caller, seeded.first.id));
      expect(episode).toMatchObject({
        parentId: seeded.seasonOne.id,
        seasonNumber: 1,
        episodeNumber: 1,
        episodeEndNumber: null,
        show: { id: seeded.show.id },
        children: [],
      });
      expect(episode.credits).toEqual([
        {
          contributorId: adam.id,
          name: "Adam Scott",
          role: "actor",
          character: "Mark S.",
        },
        {
          contributorId: britt.id,
          name: "Britt Lower",
          role: "actor",
          character: "Helly R.",
        },
        {
          contributorId: director.id,
          name: "Ben Stiller",
          role: "director",
          character: null,
        },
        {
          contributorId: writer.id,
          name: "Dan Erickson",
          role: "writer",
          character: null,
        },
      ]);
      expect(episode.versions.map((version) => version.label)).toEqual([
        "Broadcast",
        "Director's Cut",
      ]);
      expect(episode.versions[0]).toMatchObject({
        format: "video",
        durationSeconds: 3300,
        bytes: 5_000_000_000,
      });
    }));

  test("a user denied the library cannot read its details", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { viewer, token } = await seedViewer(db);
      const library = await addLibrary(db, "Shows", "shows");
      const seeded = await seedShow(db, library.id);
      await db
        .insert(libraryAccess)
        .values({ libraryId: library.id, userId: viewer.id, allowed: false });
      const caller = await authenticate(db, token);
      const error = await capture(
        runApi(getItemDetail(db, caller, seeded.first.id)),
      );
      expect(error.code).toBe("FORBIDDEN");
    }));
});

describe.skipIf(!databaseUrl)("browse search", () => {
  test("search forgives misspellings and stays inside viewable libraries", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { viewer, token } = await seedViewer(db);
      const open = await addLibrary(db, "Movies");
      const hidden = await addLibrary(db, "Hidden");
      const titles = ["Interstellar", "Inception", "Heat", "The Prestige"];
      await db.insert(items).values([
        ...titles.map((title) => ({
          libraryId: open.id,
          kind: "movie" as const,
          title,
          canonicalFolder: title,
        })),
        {
          libraryId: hidden.id,
          kind: "movie" as const,
          title: "Interstellar Wars",
          canonicalFolder: "Interstellar Wars",
        },
      ]);
      await db
        .insert(libraryAccess)
        .values({ libraryId: hidden.id, userId: viewer.id, allowed: false });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const client = rpcClient(
          `http://127.0.0.1:${server.apiServer?.port}`,
          token,
        );
        const titlesFor = async (query: string) =>
          (await client.items.search({ query })).map((item) => item.title);
        expect(await titlesFor("Interstelar")).toEqual(["Interstellar"]);
        expect((await titlesFor("  incep "))[0]).toBe("Inception");
        expect(await titlesFor("prestige")).toEqual(["The Prestige"]);
        expect(await titlesFor("Zxqvw")).toEqual([]);
        for (const query of ["   ", "a\0b", "x".repeat(201)])
          expect((await capture(client.items.search({ query }))).code).toBe(
            "BAD_REQUEST",
          );
      } finally {
        await server.stop();
      }
    }));
});
