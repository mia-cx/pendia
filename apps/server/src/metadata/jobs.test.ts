import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  artwork,
  credits,
  items,
  jobs,
  libraries,
  providerIds,
  settings,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { registerLibraryJobs } from "../libraries/jobs.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { registerMetadataJobs } from "./jobs.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP4y8CAFWEXHbQSAPZwP0G2GkFNAAAAAElFTkSuQmCC",
  "base64",
);

const tmdbDetail = {
  id: 550,
  title: "Fight Club",
  overview: "An insomniac and a soap salesman.",
  release_date: "1999-10-15",
  poster_path: "/poster.jpg",
  backdrop_path: "/backdrop.jpg",
  genres: [{ name: "Drama" }],
  credits: {
    cast: [
      { name: "Edward Norton", character: "The Narrator", order: 0 },
      { name: "Brad Pitt", character: "Tyler Durden", order: 1 },
    ],
    crew: [{ name: "David Fincher", job: "Director" }],
  },
  release_dates: {
    results: [
      {
        iso_3166_1: "US",
        release_dates: [{ certification: "R" }],
      },
    ],
  },
  external_ids: { imdb_id: "tt0137523" },
};

async function withTempRoot<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pendia-library-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fixture(db: Database, rootPath: string) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  const item = await insertItem(db, {
    libraryId: library.id,
    kind: "movie",
    title: "Alien",
    year: 1979,
    canonicalFolder: "Alien (1979) {tmdb-550}",
    extension: {},
  });
  return { library, item };
}

function mockRequest(responder: (url: URL) => Response) {
  const calls: URL[] = [];
  const request = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    calls.push(url);
    return responder(url);
  }) as typeof fetch;
  return { calls, request };
}

async function storedItem(db: Database, itemId: string) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new Error("Stored item missing.");
  return item;
}

describe.skipIf(!databaseUrl)("provider-fetch job", () => {
  test("a scanned folder flows through provider-fetch to a stored poster", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const folder = "Alien (1979) {tmdb-550}";
        await mkdir(join(root, folder));
        await createVideoFixture(join(root, folder, "Alien.mkv"));
        const [library] = await db
          .insert(libraries)
          .values({ name: "Movies", medium: "movies", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");
        await db.insert(settings).values({
          key: "metadata",
          value: { tmdb: { apiKey: "test-key" } },
        });
        const { calls, request } = mockRequest((url) => {
          if (url.hostname === "api.themoviedb.org")
            return Response.json(tmdbDetail);
          if (url.hostname === "image.tmdb.org") return new Response(png);
          throw new Error(`Unexpected request to ${url.hostname}.`);
        });
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        registerMetadataJobs(db, registry, request);
        const scanJob = await queue.enqueue({
          type: "scan",
          libraryId: library.id,
          path: folder,
        });
        const claimedScan = await queue.claim(["scan"]);
        expect(claimedScan?.id).toBe(scanJob.id);
        await registry.run(claimedScan ?? scanJob);
        await queue.complete(claimedScan ?? scanJob);
        const [item] = await db.select().from(items);
        if (!item) throw new Error("Scanned item missing.");
        const claimedFetch = await queue.claim(["provider-fetch"]);
        if (!claimedFetch) throw new Error("provider-fetch was not enqueued.");
        expect(claimedFetch.payload).toEqual({
          type: "provider-fetch",
          itemId: item.id,
        });
        await registry.run(claimedFetch);
        await queue.complete(claimedFetch);

        expect(calls).toHaveLength(2);
        const tmdb = calls.find((url) => url.hostname === "api.themoviedb.org");
        const image = calls.find((url) => url.hostname === "image.tmdb.org");
        expect(tmdb?.pathname).toBe("/3/movie/550");
        expect(tmdb?.searchParams.get("api_key")).toBe("test-key");
        expect(image?.pathname).toBe("/t/p/original/poster.jpg");
        expect(image?.searchParams.has("api_key")).toBe(false);

        expect(await storedItem(db, item.id)).toMatchObject({
          title: "Fight Club",
          year: 1999,
          contentRating: "R",
          genres: ["Drama"],
          metadataState: "matched",
        });
        expect(
          await db
            .select()
            .from(providerIds)
            .where(eq(providerIds.itemId, item.id))
            .orderBy(providerIds.provider),
        ).toMatchObject([
          { provider: "imdb", value: "tt0137523" },
          { provider: "tmdb", value: "550" },
        ]);
        expect(
          await db
            .select()
            .from(credits)
            .where(eq(credits.itemId, item.id))
            .orderBy(credits.role, credits.order),
        ).toMatchObject([
          { role: "actor", character: "The Narrator", order: 0 },
          { role: "actor", character: "Tyler Durden", order: 1 },
          { role: "director", order: 0 },
        ]);
        const rows = await db.select().from(artwork);
        expect(rows).toMatchObject([
          {
            itemId: item.id,
            versionId: null,
            type: "poster",
            sourceUrl: "https://image.tmdb.org/t/p/original/poster.jpg",
            backend: "colocated",
            storageKey: `${folder}/.pendia/artwork/${rows[0]?.id}`,
            selected: true,
          },
        ]);
        expect(await readFile(join(root, rows[0]?.storageKey ?? ""))).toEqual(
          png,
        );
      });
    }));

  test("a scanned folder with tied best search results stays unmatched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const folder = "King Kong (1933)";
        await mkdir(join(root, folder));
        await createVideoFixture(join(root, folder, "King Kong.mkv"));
        const [library] = await db
          .insert(libraries)
          .values({ name: "Movies", medium: "movies", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");
        await db.insert(settings).values({
          key: "metadata",
          value: { tmdb: { apiKey: "test-key" } },
        });
        const { calls, request } = mockRequest((url) => {
          if (
            url.hostname === "api.themoviedb.org" &&
            url.pathname === "/3/search/movie"
          )
            return Response.json({
              results: [
                { id: 244, title: "King Kong", release_date: "1933-03-07" },
                { id: 431, title: "King Kong", release_date: "1933-04-01" },
              ],
            });
          throw new Error(`Unexpected request to ${url}.`);
        });
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        registerMetadataJobs(db, registry, request);
        const scanJob = await queue.enqueue({
          type: "scan",
          libraryId: library.id,
          path: folder,
        });
        const claimedScan = await queue.claim(["scan"]);
        await registry.run(claimedScan ?? scanJob);
        await queue.complete(claimedScan ?? scanJob);
        const [item] = await db.select().from(items);
        if (!item) throw new Error("Scanned item missing.");
        const claimedFetch = await queue.claim(["provider-fetch"]);
        if (!claimedFetch) throw new Error("provider-fetch was not enqueued.");
        await registry.run(claimedFetch);
        await queue.complete(claimedFetch);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.pathname).toBe("/3/search/movie");
        expect(calls[0]?.searchParams.get("query")).toBe("King Kong");
        expect(calls[0]?.searchParams.get("year")).toBe("1933");
        expect(await storedItem(db, item.id)).toMatchObject({
          title: "King Kong",
          year: 1933,
          metadataState: "unmatched",
        });
        expect(
          await db.select().from(credits).where(eq(credits.itemId, item.id)),
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(providerIds)
            .where(eq(providerIds.itemId, item.id)),
        ).toHaveLength(0);
        expect(await db.select().from(artwork)).toHaveLength(0);
      });
    }));

  test("an explicit empty library list makes no HTTP call and stays unmatched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { library, item } = await fixture(db, root);
        await db.insert(settings).values({
          key: "metadata",
          value: {
            tmdb: { apiKey: "test-key" },
            libraries: { [library.id]: [] },
          },
        });
        const { calls, request } = mockRequest(() => {
          throw new Error("Unexpected HTTP call.");
        });
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerMetadataJobs(db, registry, request);
        const job = await queue.enqueue({
          type: "provider-fetch",
          itemId: item.id,
        });
        const claimed = await queue.claim(["provider-fetch"]);
        await registry.run(claimed ?? job);
        await queue.complete(claimed ?? job);
        expect(calls).toHaveLength(0);
        expect((await storedItem(db, item.id)).metadataState).toBe("unmatched");
        expect(await db.select().from(artwork)).toHaveLength(0);
      });
    }));

  test("a failing provider request propagates and the claimed job retries once", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        await db
          .insert(providerIds)
          .values({ provider: "tmdb", value: "550", itemId: item.id });
        await db.insert(settings).values({
          key: "metadata",
          value: { tmdb: { apiKey: "test-key" } },
        });
        let failOnce = true;
        const { request } = mockRequest((url) => {
          if (url.hostname === "api.themoviedb.org") {
            if (failOnce) {
              failOnce = false;
              throw new Error("socket hang up");
            }
            return Response.json(tmdbDetail);
          }
          return new Response(png);
        });
        const queue = createJobQueue(db, { retryDelayMs: 1 });
        const registry = createJobRegistry();
        registerMetadataJobs(db, registry, request);
        const job = await queue.enqueue({
          type: "provider-fetch",
          itemId: item.id,
        });
        const claimed = await queue.claim(["provider-fetch"]);
        if (!claimed) throw new Error("Job was not claimed.");
        await expect(registry.run(claimed)).rejects.toThrow("socket hang up");
        await queue.fail(claimed, new Error("socket hang up"));
        await db
          .update(jobs)
          .set({ runAfter: new Date(0) })
          .where(eq(jobs.id, job.id));
        const retried = await queue.claim(["provider-fetch"]);
        expect(retried?.id).toBe(job.id);
        expect(retried?.attempts).toBe(2);
        await registry.run(retried ?? job);
        await queue.complete(retried ?? job);
        expect((await storedItem(db, item.id)).metadataState).toBe("matched");
        const rows = await db.select().from(artwork);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.selected).toBe(true);
      });
    }));

  test("registerMetadataJobs registers only provider-fetch", () =>
    withDatabase(async (db) => {
      const registry = createJobRegistry();
      registerMetadataJobs(db, registry);
      expect(registry.types()).toEqual(["provider-fetch"]);
    }));
});
