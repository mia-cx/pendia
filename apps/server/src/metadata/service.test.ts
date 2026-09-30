import { describe, expect, test } from "bun:test";
import type {
  ItemKind,
  MetadataMatch,
  MetadataProvider,
  MetadataResult,
} from "@pendia/plugin-api";
import { and, eq, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  contributors,
  credits,
  items,
  libraries,
  providerIds,
  settings,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { setItemProviderIds } from "../libraries/changes.ts";
import { applyMetadata } from "./service.ts";

type SearchQuery = Parameters<MetadataProvider["search"]>[0];
type FetchQuery = Parameters<MetadataProvider["fetch"]>[0];

function mockProvider(
  id: string,
  behavior: {
    kinds?: ItemKind[];
    search?: (query: SearchQuery) => MetadataMatch[] | Promise<MetadataMatch[]>;
    fetch?: (
      match: FetchQuery,
    ) => MetadataResult | null | Promise<MetadataResult | null>;
  } = {},
) {
  const calls = { search: [] as SearchQuery[], fetch: [] as FetchQuery[] };
  const provider: MetadataProvider = {
    id,
    kinds: behavior.kinds ?? ["movie"],
    search: async (query) => {
      calls.search.push(query);
      return behavior.search ? behavior.search(query) : [];
    },
    fetch: async (match) => {
      calls.fetch.push(match);
      if (!behavior.fetch) throw new Error(`Unexpected fetch for ${id}.`);
      return behavior.fetch(match);
    },
  };
  return { calls, provider };
}

function fetchedResult(
  overrides: Partial<MetadataResult> = {},
): MetadataResult {
  return {
    title: "Fetched Title",
    overview: "Fetched overview.",
    year: 2010,
    contentRating: "PG-13",
    genres: ["Science Fiction"],
    credits: [{ name: "Christopher Nolan", role: "director", order: 0 }],
    artwork: [
      { type: "poster", url: "https://image.tmdb.org/t/p/original/poster.jpg" },
    ],
    providerIds: { tmdb: "550", imdb: "tt1375666" },
    ...overrides,
  };
}

async function fixture(db: Database) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: "/movies" })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  const item = await insertItem(db, {
    libraryId: library.id,
    title: "Inception",
    year: 2010,
    kind: "movie",
    canonicalFolder: "/movies/inception",
    extension: {},
  });
  return { library, item };
}

async function storedItem(db: Database, itemId: string) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new Error("Stored item missing.");
  return item;
}

async function itemProviderIds(db: Database, itemId: string) {
  return db
    .select({ provider: providerIds.provider, value: providerIds.value })
    .from(providerIds)
    .where(eq(providerIds.itemId, itemId))
    .orderBy(providerIds.provider);
}

async function waitForLibraryLockWait(db: Database) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.execute(sql`
      select 1 from pg_stat_activity
      where wait_event_type = 'Lock'
        and state = 'active'
        and query like '%from "libraries"%for update%'
    `);
    if (rows.length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the library lock wait.");
}

describe.skipIf(!databaseUrl)("applyMetadata", () => {
  test("an existing provider id fetches directly and applies the result", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      await db
        .insert(providerIds)
        .values({ provider: "tmdb", value: "550", itemId: item.id });
      const { calls, provider } = mockProvider("tmdb", {
        fetch: async () => fetchedResult(),
      });
      const application = await applyMetadata(db, item.id, [provider]);
      expect(calls.search).toHaveLength(0);
      expect(calls.fetch).toEqual([{ providerId: "550", kind: "movie" }]);
      expect(application).toEqual({
        state: "matched",
        provider: "tmdb",
        providerId: "550",
        confidence: 1,
        artwork: [
          {
            type: "poster",
            url: "https://image.tmdb.org/t/p/original/poster.jpg",
          },
        ],
      });
      expect(await storedItem(db, item.id)).toMatchObject({
        title: "Fetched Title",
        overview: "Fetched overview.",
        year: 2010,
        contentRating: "PG-13",
        genres: ["Science Fiction"],
        metadataState: "matched",
      });
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "imdb", value: "tt1375666" },
        { provider: "tmdb", value: "550" },
      ]);
      const allContributors = await db.select().from(contributors);
      expect(allContributors).toMatchObject([{ name: "Christopher Nolan" }]);
      expect(
        await db.select().from(credits).where(eq(credits.itemId, item.id)),
      ).toEqual([
        expect.objectContaining({
          contributorId: allContributors[0]?.id,
          role: "director",
          character: null,
          order: 0,
        }),
      ]);
    }));

  test("title and year search accepts one unique best match at the threshold", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      const { calls, provider } = mockProvider("tmdb", {
        search: async () => [
          { providerId: "1", title: "Ince", year: 2010, confidence: 0.7 },
          { providerId: "2", title: "Inception", year: 2010, confidence: 0.95 },
          { providerId: "3", title: "Other", year: 2009, confidence: 0.5 },
        ],
        fetch: async () => fetchedResult(),
      });
      const application = await applyMetadata(db, item.id, [provider]);
      expect(calls.search).toEqual([
        { title: "Inception", year: 2010, kind: "movie", providerIds: {} },
      ]);
      expect(calls.fetch).toEqual([{ providerId: "2", kind: "movie" }]);
      expect(application).toMatchObject({
        state: "matched",
        provider: "tmdb",
        providerId: "2",
        confidence: 0.95,
      });
      expect((await storedItem(db, item.id)).metadataState).toBe("matched");
      const yearless = await insertItem(db, {
        libraryId: item.libraryId,
        title: "Yearless",
        kind: "movie",
        canonicalFolder: "/movies/yearless",
        extension: {},
      });
      await applyMetadata(db, yearless.id, [provider]);
      expect(calls.search[1]?.title).toBe("Yearless");
      expect(calls.search[1]?.year).toBeUndefined();
    }));

  test("a search result owned by another Item in the Library stays unmatched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { library, item } = await fixture(db);
      const owner = await insertItem(db, {
        libraryId: library.id,
        title: "Fight Club",
        kind: "movie",
        canonicalFolder: "/movies/fight-club",
        extension: {},
      });
      await db
        .insert(providerIds)
        .values({ itemId: owner.id, provider: "tmdb", value: "550" });
      const { provider } = mockProvider("tmdb", {
        search: async () => [
          {
            providerId: "550",
            title: "Inception",
            year: 2010,
            confidence: 0.95,
          },
        ],
        fetch: async () => fetchedResult(),
      });
      const application = await applyMetadata(db, item.id, [provider]);
      expect(application).toEqual({ state: "unmatched", artwork: [] });
      const stored = await storedItem(db, item.id);
      expect(stored).toMatchObject({
        title: "Inception",
        year: 2010,
        metadataState: "unmatched",
      });
      expect(await itemProviderIds(db, item.id)).toEqual([]);
      expect(
        await db.select().from(credits).where(eq(credits.itemId, item.id)),
      ).toEqual([]);

      // The same provider id in a different Library does not collide.
      const [otherLibrary] = await db
        .insert(libraries)
        .values({ name: "Other", medium: "movies", rootPath: "/other" })
        .returning();
      if (!otherLibrary) throw new Error("Other library missing.");
      const elsewhere = await insertItem(db, {
        libraryId: otherLibrary.id,
        title: "Elsewhere",
        kind: "movie",
        canonicalFolder: "/other/elsewhere",
        extension: {},
      });
      const control = await applyMetadata(db, elsewhere.id, [provider]);
      expect(control).toMatchObject({ state: "matched" });
    }));

  test("tries providers in configured order and skips unusable ones", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { library, item } = await fixture(db);
      await db.insert(settings).values({
        key: "metadata",
        value: {
          providerOrder: ["gamma", "alpha", "beta", "ghost"],
          libraries: { [library.id]: ["gamma", "alpha", "beta", "ghost"] },
        },
      });
      const gamma = mockProvider("gamma", { kinds: ["show"] });
      const alpha = mockProvider("alpha", {
        search: async () => [
          { providerId: "a1", title: "Inception", year: 2010, confidence: 0.2 },
        ],
        fetch: async () => fetchedResult(),
      });
      const beta = mockProvider("beta", {
        search: async () => [
          {
            providerId: "b9",
            title: "Inception",
            year: 2010,
            confidence: 0.95,
          },
        ],
        fetch: async () => fetchedResult({ providerIds: { beta: "b9" } }),
      });
      const application = await applyMetadata(db, item.id, [
        gamma.provider,
        alpha.provider,
        beta.provider,
      ]);
      expect(application).toMatchObject({
        state: "matched",
        provider: "beta",
        providerId: "b9",
      });
      expect(gamma.calls.search).toHaveLength(0);
      expect(gamma.calls.fetch).toHaveLength(0);
      expect(alpha.calls.search).toHaveLength(1);
      expect(alpha.calls.fetch).toHaveLength(0);
      expect(beta.calls.search).toHaveLength(1);
      expect(beta.calls.fetch).toHaveLength(1);
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "beta", value: "b9" },
      ]);
    }));

  test("a winning provider prevents later provider calls", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { library, item } = await fixture(db);
      await db.insert(settings).values({
        key: "metadata",
        value: {
          providerOrder: ["alpha", "beta"],
          libraries: { [library.id]: ["alpha", "beta"] },
        },
      });
      const alpha = mockProvider("alpha", {
        search: async () => [
          {
            providerId: "a1",
            title: "Inception",
            year: 2010,
            confidence: 0.95,
          },
        ],
        fetch: async () => fetchedResult({ providerIds: { alpha: "a1" } }),
      });
      const beta = mockProvider("beta", {
        search: async () => [
          {
            providerId: "b1",
            title: "Inception",
            year: 2010,
            confidence: 0.99,
          },
        ],
        fetch: async () => fetchedResult(),
      });
      const application = await applyMetadata(db, item.id, [
        alpha.provider,
        beta.provider,
      ]);
      expect(application).toMatchObject({
        state: "matched",
        provider: "alpha",
      });
      expect(beta.calls.search).toHaveLength(0);
      expect(beta.calls.fetch).toHaveLength(0);
    }));

  test("a stored id the provider no longer knows stores unmatched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      await db
        .insert(providerIds)
        .values({ provider: "tmdb", value: "348", itemId: item.id });
      const { calls, provider } = mockProvider("tmdb", {
        fetch: async () => null,
      });
      const application = await applyMetadata(db, item.id, [provider]);
      expect(application).toEqual({ state: "unmatched", artwork: [] });
      expect(calls.search).toHaveLength(0);
      expect(await storedItem(db, item.id)).toMatchObject({
        title: "Inception",
        metadataState: "unmatched",
      });
    }));

  test("an explicit empty library list makes no calls and leaves the Item pending", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { library, item } = await fixture(db);
      await db.insert(settings).values({
        key: "metadata",
        value: { libraries: { [library.id]: [] } },
      });
      const { calls, provider } = mockProvider("tmdb", {
        fetch: async () => fetchedResult(),
      });
      const application = await applyMetadata(db, item.id, [provider]);
      expect(application).toEqual({ state: "pending", artwork: [] });
      expect(calls.search).toHaveLength(0);
      expect(calls.fetch).toHaveLength(0);
      expect(await storedItem(db, item.id)).toMatchObject({
        title: "Inception",
        metadataState: "pending",
      });
    }));

  test("below-threshold, tied and empty results store unmatched without fetch", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      const below = mockProvider("tmdb", {
        search: async () => [
          { providerId: "1", title: "Close", year: 2010, confidence: 0.89 },
        ],
        fetch: async () => fetchedResult(),
      });
      expect(await applyMetadata(db, item.id, [below.provider])).toEqual({
        state: "unmatched",
        artwork: [],
      });
      const tied = mockProvider("tmdb", {
        search: async () => [
          { providerId: "1", title: "Inception", year: 2010, confidence: 0.95 },
          { providerId: "2", title: "Inception", year: 2010, confidence: 0.95 },
        ],
        fetch: async () => fetchedResult(),
      });
      expect(await applyMetadata(db, item.id, [tied.provider])).toEqual({
        state: "unmatched",
        artwork: [],
      });
      const empty = mockProvider("tmdb", {
        search: async () => [],
        fetch: async () => fetchedResult(),
      });
      expect(await applyMetadata(db, item.id, [empty.provider])).toEqual({
        state: "unmatched",
        artwork: [],
      });
      for (const mock of [below, tied, empty])
        expect(mock.calls.fetch).toHaveLength(0);
      expect((await storedItem(db, item.id)).metadataState).toBe("unmatched");
    }));

  test("an item deleted during search rejects instead of storing unmatched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      let searchStarted: () => void = () => {};
      let releaseSearch: (matches: MetadataMatch[]) => void = () => {};
      const started = new Promise<void>((resolve) => {
        searchStarted = resolve;
      });
      const released = new Promise<MetadataMatch[]>((resolve) => {
        releaseSearch = resolve;
      });
      const { provider } = mockProvider("tmdb", {
        search: () => {
          searchStarted();
          return released;
        },
      });
      const pending = applyMetadata(db, item.id, [provider]);
      await started;
      await db.delete(items).where(eq(items.id, item.id));
      releaseSearch([]);
      const error = await pending.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("NOT_FOUND");
    }));

  test("a provider id changed during fetch rejects the stale application", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      await db
        .insert(providerIds)
        .values({ provider: "tmdb", value: "old", itemId: item.id });
      let fetchStarted: () => void = () => {};
      let releaseFetch: (result: MetadataResult) => void = () => {};
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      const released = new Promise<MetadataResult>((resolve) => {
        releaseFetch = resolve;
      });
      const { provider } = mockProvider("tmdb", {
        fetch: () => {
          fetchStarted();
          return released;
        },
      });
      const pending = applyMetadata(db, item.id, [provider]);
      await started;
      await db
        .update(providerIds)
        .set({ value: "new" })
        .where(
          and(
            eq(providerIds.itemId, item.id),
            eq(providerIds.provider, "tmdb"),
          ),
        );
      releaseFetch(fetchedResult({ providerIds: { tmdb: "old" } }));
      await expect(pending).rejects.toThrow(
        "Provider ids changed during metadata fetch.",
      );
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "tmdb", value: "new" },
      ]);
      expect(await storedItem(db, item.id)).toMatchObject({
        title: "Inception",
        metadataState: "pending",
      });
      expect(await db.select().from(credits)).toEqual([]);
    }));

  test("another provider's id changing during a search match rejects it", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      let fetchStarted: () => void = () => {};
      let releaseFetch: (result: MetadataResult) => void = () => {};
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      const released = new Promise<MetadataResult>((resolve) => {
        releaseFetch = resolve;
      });
      const { provider } = mockProvider("tmdb", {
        search: async () => [
          {
            providerId: "550",
            title: "Inception",
            year: 2010,
            confidence: 0.99,
          },
        ],
        fetch: () => {
          fetchStarted();
          return released;
        },
      });
      const pending = applyMetadata(db, item.id, [provider]);
      await started;
      // A scan corrects the IMDb id while the TMDB fetch is in flight.
      await setItemProviderIds(db, item.id, { imdb: "tt1375666" });
      releaseFetch(fetchedResult());
      await expect(pending).rejects.toThrow(
        "Provider ids changed during metadata fetch.",
      );
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "imdb", value: "tt1375666" },
      ]);
      expect(await storedItem(db, item.id)).toMatchObject({
        title: "Inception",
        metadataState: "pending",
      });
    }));

  test("a scan-held library lock serializes a stale provider id change", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { library, item } = await fixture(db);
      await db
        .insert(providerIds)
        .values({ provider: "tmdb", value: "old", itemId: item.id });
      let fetchStarted: () => void = () => {};
      let releaseFetch: (result: MetadataResult) => void = () => {};
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      const released = new Promise<MetadataResult>((resolve) => {
        releaseFetch = resolve;
      });
      const { provider } = mockProvider("tmdb", {
        fetch: () => {
          fetchStarted();
          return released;
        },
      });
      const pending = applyMetadata(db, item.id, [provider]);
      await started;

      const second = createDatabase(url);
      try {
        let lockAcquired: () => void = () => {};
        let releaseLock: () => void = () => {};
        const acquired = new Promise<void>((resolve) => {
          lockAcquired = resolve;
        });
        const held = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        const blocker = second.db.transaction(async (tx) => {
          await tx
            .select({ id: libraries.id })
            .from(libraries)
            .where(eq(libraries.id, library.id))
            .for("update");
          await tx
            .update(providerIds)
            .set({ value: "new" })
            .where(
              and(
                eq(providerIds.itemId, item.id),
                eq(providerIds.provider, "tmdb"),
              ),
            );
          lockAcquired();
          await held;
        });
        await acquired;
        releaseFetch(fetchedResult({ providerIds: { tmdb: "old" } }));
        await waitForLibraryLockWait(db);
        releaseLock();
        await blocker;
        await expect(pending).rejects.toThrow(
          "Provider ids changed during metadata fetch.",
        );
        expect(await itemProviderIds(db, item.id)).toEqual([
          { provider: "tmdb", value: "new" },
        ]);
        expect(await storedItem(db, item.id)).toMatchObject({
          title: "Inception",
          metadataState: "pending",
        });
        expect(await db.select().from(credits)).toEqual([]);
      } finally {
        await second.close();
      }
    }));

  test("a missing item throws NOT_FOUND", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { provider } = mockProvider("tmdb");
      const error = await applyMetadata(db, Bun.randomUUIDv7(), [
        provider,
      ]).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("NOT_FOUND");
    }));

  test("reapplying replaces provider ids and credits while reusing contributors", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      const [existingContributor] = await db
        .insert(contributors)
        .values({ name: "Existing Name" })
        .returning();
      if (!existingContributor) throw new Error("Contributor fixture missing.");
      await db
        .insert(providerIds)
        .values({ provider: "tvdb", value: "123", itemId: item.id });
      const results = [
        fetchedResult({
          providerIds: { tmdb: "550", imdb: "tt1375666" },
          credits: [
            {
              name: "Existing Name",
              role: "actor",
              character: "Doc",
              order: 0,
            },
            { name: "Christopher Nolan", role: "director", order: 0 },
            { name: "Christopher Nolan", role: "writer", order: 0 },
          ],
        }),
        fetchedResult({
          providerIds: { tmdb: "550", imdb: "tt9999999" },
          credits: [{ name: "Christopher Nolan", role: "director", order: 0 }],
        }),
      ];
      const { calls, provider } = mockProvider("tmdb", {
        search: async () => [
          {
            providerId: "550",
            title: "Inception",
            year: 2010,
            confidence: 0.99,
          },
        ],
        fetch: async () => {
          const next = results.shift();
          if (!next) throw new Error("Unexpected extra fetch.");
          return next;
        },
      });
      await applyMetadata(db, item.id, [provider]);
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "imdb", value: "tt1375666" },
        { provider: "tmdb", value: "550" },
        { provider: "tvdb", value: "123" },
      ]);
      const firstCredits = await db
        .select()
        .from(credits)
        .where(eq(credits.itemId, item.id))
        .orderBy(credits.role);
      const allContributors = await db
        .select()
        .from(contributors)
        .orderBy(contributors.name);
      const nolan = allContributors.find(
        (contributor) => contributor.name === "Christopher Nolan",
      );
      expect(allContributors).toHaveLength(2);
      expect(firstCredits).toEqual([
        expect.objectContaining({
          contributorId: existingContributor.id,
          role: "actor",
          character: "Doc",
          order: 0,
        }),
        expect.objectContaining({
          contributorId: nolan?.id,
          role: "director",
          character: null,
          order: 0,
        }),
        expect.objectContaining({
          contributorId: nolan?.id,
          role: "writer",
          character: null,
          order: 0,
        }),
      ]);
      const application = await applyMetadata(db, item.id, [provider]);
      expect(application).toMatchObject({ state: "matched", confidence: 1 });
      expect(calls.search).toHaveLength(1);
      expect(calls.fetch).toHaveLength(2);
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "imdb", value: "tt9999999" },
        { provider: "tmdb", value: "550" },
        { provider: "tvdb", value: "123" },
      ]);
      expect(
        await db.select().from(credits).where(eq(credits.itemId, item.id)),
      ).toEqual([
        expect.objectContaining({
          contributorId: nolan?.id,
          role: "director",
          order: 0,
        }),
      ]);
      expect(await db.select().from(contributors)).toHaveLength(2);
    }));

  test("concurrent matches share one contributor per exact name", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      const other = await insertItem(db, {
        libraryId: item.libraryId,
        title: "Sequel",
        kind: "movie",
        canonicalFolder: "/movies/sequel",
        extension: {},
      });
      await db.insert(providerIds).values([
        { provider: "tmdb", value: "1", itemId: item.id },
        { provider: "tmdb", value: "2", itemId: other.id },
      ]);
      let release = () => {};
      let allArrived = () => {};
      const releaseGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const arrivedGate = new Promise<void>((resolve) => {
        allArrived = resolve;
      });
      let arrived = 0;
      const provider: MetadataProvider = {
        id: "tmdb",
        kinds: ["movie"],
        search: async () => [],
        fetch: async (match) => {
          arrived += 1;
          if (arrived === 2) allArrived();
          await releaseGate;
          return fetchedResult({
            title: `Title ${match.providerId}`,
            credits: [{ name: "Shared Name", role: "director", order: 0 }],
            providerIds: { tmdb: match.providerId },
          });
        },
      };
      const first = applyMetadata(db, item.id, [provider]);
      const second = applyMetadata(db, other.id, [provider]);
      await arrivedGate;
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toMatchObject({ state: "matched" });
      expect(b).toMatchObject({ state: "matched" });
      const shared = await db
        .select()
        .from(contributors)
        .where(eq(contributors.name, "Shared Name"));
      expect(shared).toHaveLength(1);
      const contributor = shared[0];
      if (!contributor) throw new Error("Expected one Contributor row.");
      const rows = await db.select().from(credits).orderBy(credits.itemId);
      expect(rows.map((row) => row.contributorId)).toEqual([
        contributor.id,
        contributor.id,
      ]);
    }));

  test("invalid provider id entries reject before touching stored metadata", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      const matches = [
        { providerId: "9", title: "Inception", year: 2010, confidence: 0.99 },
      ];
      const badIds: Record<string, string>[] = [
        { "": "x" },
        { "  ": "x" },
        { tmdb: "" },
        { tmdb: "   " },
      ];
      for (const bad of badIds) {
        const { provider } = mockProvider("tmdb", {
          search: async () => matches,
          fetch: async () => fetchedResult({ providerIds: bad }),
        });
        await expect(applyMetadata(db, item.id, [provider])).rejects.toThrow(
          "Invalid provider metadata.",
        );
      }
      const { provider } = mockProvider("tmdb", {
        search: async () => matches,
        fetch: async () =>
          fetchedResult({ providerIds: { " tmdb ": " 550 " } }),
      });
      expect(await applyMetadata(db, item.id, [provider])).toMatchObject({
        state: "matched",
      });
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "tmdb", value: "550" },
      ]);
      const [stored] = await db
        .select()
        .from(items)
        .where(eq(items.id, item.id));
      expect(stored?.metadataState).toBe("matched");
    }));

  test("a provider fetch failure propagates and leaves the item pending", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { library, item } = await fixture(db);
      const failing = mockProvider("tmdb", {
        search: async () => [
          { providerId: "9", title: "Inception", year: 2010, confidence: 0.99 },
        ],
        fetch: async () => {
          throw new Error("TMDB is down.");
        },
      });
      await expect(
        applyMetadata(db, item.id, [failing.provider]),
      ).rejects.toThrow("TMDB is down.");
      expect(await storedItem(db, item.id)).toMatchObject({
        title: "Inception",
        metadataState: "pending",
      });
      expect(await itemProviderIds(db, item.id)).toEqual([]);
      expect(
        await db.select().from(credits).where(eq(credits.itemId, item.id)),
      ).toEqual([]);
      await db.insert(settings).values({
        key: "metadata",
        value: {
          providerOrder: ["tmdb", "beta"],
          libraries: { [library.id]: ["tmdb", "beta"] },
        },
      });
      await db
        .insert(providerIds)
        .values({ provider: "tmdb", value: "550", itemId: item.id });
      const fallback = mockProvider("beta", {
        search: async () => [
          { providerId: "b1", title: "Inception", year: 2010, confidence: 1 },
        ],
        fetch: async () => fetchedResult(),
      });
      await expect(
        applyMetadata(db, item.id, [failing.provider, fallback.provider]),
      ).rejects.toThrow("TMDB is down.");
      expect(failing.calls.search).toHaveLength(1);
      expect(failing.calls.fetch).toHaveLength(2);
      expect(fallback.calls.search).toHaveLength(0);
      expect(fallback.calls.fetch).toHaveLength(0);
      expect((await storedItem(db, item.id)).metadataState).toBe("pending");
    }));

  test("an unmatched result rejects when provider ids changed during search", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      let searchStarted: () => void = () => {};
      let releaseSearch: (matches: MetadataMatch[]) => void = () => {};
      const started = new Promise<void>((resolve) => {
        searchStarted = resolve;
      });
      const released = new Promise<MetadataMatch[]>((resolve) => {
        releaseSearch = resolve;
      });
      const { provider } = mockProvider("tmdb", {
        search: () => {
          searchStarted();
          return released;
        },
      });
      const pending = applyMetadata(db, item.id, [provider]);
      await started;
      // A scan-written id mid-flight makes the no-match result stale.
      await setItemProviderIds(db, item.id, { tmdb: "550" });
      await db
        .update(items)
        .set({ metadataState: "pending" })
        .where(eq(items.id, item.id));
      releaseSearch([]);
      await expect(pending).rejects.toThrow(
        "Provider ids changed during metadata fetch.",
      );
      expect(await storedItem(db, item.id)).toMatchObject({
        metadataState: "pending",
      });
      expect(await itemProviderIds(db, item.id)).toEqual([
        { provider: "tmdb", value: "550" },
      ]);
    }));

  test("a replacement result removes only provider-derived ids", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      const { provider } = mockProvider("tmdb", {
        search: async () => [
          {
            providerId: "550",
            title: "Inception",
            year: 2010,
            confidence: 0.99,
          },
        ],
        fetch: async () =>
          fetchedResult({
            providerIds: { tmdb: "550", imdb: "tt1375666" },
          }),
      });
      const first = await applyMetadata(db, item.id, [provider]);
      expect(first.state).toBe("matched");
      expect(
        (
          await db
            .select()
            .from(providerIds)
            .where(eq(providerIds.itemId, item.id))
        )
          .map((row) => ({
            provider: row.provider,
            value: row.value,
            metadataDerived: row.metadataDerived,
          }))
          .sort((a, b) => a.provider.localeCompare(b.provider)),
      ).toEqual([
        { provider: "imdb", value: "tt1375666", metadataDerived: true },
        { provider: "tmdb", value: "550", metadataDerived: true },
      ]);

      const { provider: replacement } = mockProvider("tmdb", {
        fetch: async () => fetchedResult({ providerIds: { tmdb: "551" } }),
      });
      const second = await applyMetadata(db, item.id, [replacement]);
      expect(second.state).toBe("matched");
      expect(
        await db
          .select()
          .from(providerIds)
          .where(eq(providerIds.itemId, item.id)),
      ).toEqual([
        expect.objectContaining({
          provider: "tmdb",
          value: "551",
          metadataDerived: true,
        }),
      ]);
    }));

  test("provider results preserve explicit scan-owned ids", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      await setItemProviderIds(db, item.id, { imdb: "tt0000000" });
      const { provider } = mockProvider("tmdb", {
        search: async () => [
          {
            providerId: "550",
            title: "Inception",
            year: 2010,
            confidence: 0.99,
          },
        ],
        fetch: async () => fetchedResult(),
      });
      const application = await applyMetadata(db, item.id, [provider]);
      expect(application.state).toBe("matched");
      expect(
        (
          await db
            .select()
            .from(providerIds)
            .where(eq(providerIds.itemId, item.id))
        )
          .map((row) => ({
            provider: row.provider,
            value: row.value,
            metadataDerived: row.metadataDerived,
          }))
          .sort((a, b) => a.provider.localeCompare(b.provider)),
      ).toEqual([
        { provider: "imdb", value: "tt0000000", metadataDerived: false },
        { provider: "tmdb", value: "550", metadataDerived: true },
      ]);
    }));

  test("a scan upsert of the same value makes a derived id explicit", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      const { provider } = mockProvider("tmdb", {
        search: async () => [
          {
            providerId: "550",
            title: "Inception",
            year: 2010,
            confidence: 0.99,
          },
        ],
        fetch: async () => fetchedResult(),
      });
      await applyMetadata(db, item.id, [provider]);
      expect(await setItemProviderIds(db, item.id, { tmdb: "550" })).toBe(true);
      const rows = await db
        .select()
        .from(providerIds)
        .where(eq(providerIds.itemId, item.id));
      expect(rows.find((row) => row.provider === "tmdb")).toMatchObject({
        value: "550",
        metadataDerived: false,
      });
      expect(rows.find((row) => row.provider === "imdb")).toMatchObject({
        value: "tt1375666",
        metadataDerived: true,
      });
    }));

  test("a provenance-only id change during search rejects unmatched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { item } = await fixture(db);
      // A provider-derived IMDb id exists while the searched provider (tmdb)
      // has none, so the snapshot does not short-circuit into a fetch.
      await db.insert(providerIds).values({
        provider: "imdb",
        value: "tt1375666",
        itemId: item.id,
        metadataDerived: true,
      });
      let searchStarted: () => void = () => {};
      let releaseSearch: (matches: MetadataMatch[]) => void = () => {};
      const started = new Promise<void>((resolve) => {
        searchStarted = resolve;
      });
      const released = new Promise<MetadataMatch[]>((resolve) => {
        releaseSearch = resolve;
      });
      const { provider } = mockProvider("tmdb", {
        search: () => {
          searchStarted();
          return released;
        },
      });
      const pending = applyMetadata(db, item.id, [provider]);
      await started;
      // The scan reasserts the same value: provenance flips to explicit.
      expect(await setItemProviderIds(db, item.id, { imdb: "tt1375666" })).toBe(
        true,
      );
      await db
        .update(items)
        .set({ metadataState: "pending" })
        .where(eq(items.id, item.id));
      releaseSearch([]);
      await expect(pending).rejects.toThrow(
        "Provider ids changed during metadata fetch.",
      );
      expect(await storedItem(db, item.id)).toMatchObject({
        metadataState: "pending",
      });
      expect(
        await db
          .select()
          .from(providerIds)
          .where(eq(providerIds.itemId, item.id)),
      ).toMatchObject([
        { provider: "imdb", value: "tt1375666", metadataDerived: false },
      ]);
    }));
});
