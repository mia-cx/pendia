import { describe, expect, test } from "bun:test";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { sql } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { authenticate, createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { runApi } from "./errors.ts";
import { type ListItemsInput, listItemCards } from "./items.ts";
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
