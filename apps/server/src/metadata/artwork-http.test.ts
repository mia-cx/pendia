import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { startApiServer } from "../api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork, libraryAccess, settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { insertLibraries } from "../libraries/testing.ts";
import type { ArtworkStoreConfig } from "./artwork-backends.ts";
import { type ArtworkResize, createArtworkHandler } from "./artwork-http.ts";
import { storeArtworkOriginal } from "./artwork-store.ts";
import { s3Url, testS3Store } from "./testing.ts";

const alwaysReady = async () => true;

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP4y8CAFWEXHbQSAPZwP0G2GkFNAAAAAElFTkSuQmCC",
  "base64",
);

const poster = {
  type: "poster",
  url: "https://image.example/poster.png",
} as const;

async function withTempRoot<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pendia-library-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function respondWith(bytes: Uint8Array): typeof fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(Buffer.from(bytes))) as typeof fetch;
}

async function seed(
  db: Database,
  root: string,
  bytes: Uint8Array,
  store: ArtworkStoreConfig = { backend: "colocated" },
) {
  const [library] = await insertLibraries(db, {
    name: "Movies",
    medium: "movies",
    rootPath: root,
  });
  if (!library) throw new Error("Fixture library missing.");
  const item = await insertItem(db, {
    libraryId: library.id,
    kind: "movie",
    title: "Alien",
    year: 1979,
    canonicalFolder: "Alien (1979)",
    extension: {},
  });
  await mkdir(join(root, item.canonicalFolder), { recursive: true });
  const row = await storeArtworkOriginal(
    db,
    item.id,
    poster,
    respondWith(bytes),
    { store },
  );
  return { item, row };
}

async function withServer<T>(
  db: Database,
  options: Parameters<typeof createArtworkHandler>[1],
  run: (base: string) => Promise<T>,
): Promise<T> {
  const server = startApiServer(alwaysReady, 0, {
    artwork: createArtworkHandler(db, options),
  });
  try {
    return await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

describe.skipIf(!databaseUrl)("artwork http", () => {
  for (const backend of ["colocated", "configured-path", "s3"] as const)
    test.skipIf(backend === "s3" && !s3Url)(
      `a fresh install serves artwork from the ${backend} store`,
      () =>
        withDatabase(async (db) => {
          await migrateDatabase(db);
          await withTempRoot(async (root) => {
            await withTempRoot(async (path) => {
              const store: ArtworkStoreConfig =
                backend === "colocated"
                  ? { backend }
                  : backend === "configured-path"
                    ? { backend, path }
                    : testS3Store();
              const { row } = await seed(db, root, png, store);
              expect(row.backend).toBe(backend);
              await withServer(db, { store }, async (base) => {
                const response = await fetch(
                  `${base}/api/artwork/${row.id}?width=4`,
                );
                expect(response.status).toBe(200);
                expect(response.headers.get("content-type")).toBe("image/png");
                const bytes = new Uint8Array(await response.arrayBuffer());
                expect((await new Bun.Image(bytes).metadata()).width).toBe(4);
              });
            });
          });
        }),
    );

  test("labels a re-encoded GIF with the output type", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const gif = Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          "base64",
        );
        const { row } = await seed(db, root, gif);
        await withServer(db, {}, async (base) => {
          const response = await fetch(`${base}/api/artwork/${row.id}?width=4`);
          expect(response.status).toBe(200);
          const bytes = Buffer.from(await response.arrayBuffer());
          const { format } = await new Bun.Image(bytes).metadata();
          expect(response.headers.get("content-type")).toBe(`image/${format}`);
        });
      });
    }));

  test("serves a real resize of a stored original", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        await withServer(db, {}, async (base) => {
          const url = `${base}/api/artwork/${row.id}?width=4`;
          const response = await fetch(url);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("image/png");
          expect(response.headers.get("cache-control")).toBe(
            "public, max-age=0, must-revalidate",
          );
          expect(response.headers.get("x-content-type-options")).toBe(
            "nosniff",
          );
          const etag = response.headers.get("etag") ?? "";
          expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
          const bytes = Buffer.from(await response.arrayBuffer());
          expect(Number(response.headers.get("content-length"))).toBe(
            bytes.byteLength,
          );
          const meta = await new Bun.Image(bytes).metadata();
          expect({ width: meta.width, height: meta.height }).toEqual({
            width: 4,
            height: 4,
          });

          const enlarged = await fetch(
            `${base}/api/artwork/${row.id}?width=20`,
          );
          expect(enlarged.status).toBe(200);
          const big = await new Bun.Image(
            Buffer.from(await enlarged.arrayBuffer()),
          ).metadata();
          expect({ width: big.width, height: big.height }).toEqual({
            width: 8,
            height: 8,
          });
        });
      });
    }));

  test("caches resized output behind a strong content etag", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item, row } = await seed(db, root, png);
        const calls: number[] = [];
        const resize: ArtworkResize = async (input, width) => {
          calls.push(width);
          return { bytes: input, contentType: "image/x-artwork" };
        };
        await withServer(db, { resize }, async (base) => {
          const url = `${base}/api/artwork/${row.id}?width=4`;
          const first = await fetch(url);
          expect(first.status).toBe(200);
          const etag = first.headers.get("etag") ?? "";
          expect(etag.startsWith('"')).toBe(true);
          expect(first.headers.get("content-length")).toBe(
            String(png.byteLength),
          );
          expect(Buffer.from(await first.arrayBuffer())).toEqual(png);

          const second = await fetch(url);
          expect(second.status).toBe(200);
          expect(second.headers.get("etag")).toBe(etag);
          expect(second.headers.get("content-length")).toBe(
            String(png.byteLength),
          );
          expect(Buffer.from(await second.arrayBuffer())).toEqual(png);
          expect(calls).toEqual([4]);

          const matched = await fetch(url, {
            headers: { "if-none-match": etag },
          });
          expect(matched.status).toBe(304);
          expect(matched.headers.get("etag")).toBe(etag);
          expect(matched.headers.get("cache-control")).toBe(
            "public, max-age=0, must-revalidate",
          );
          const listed = await fetch(url, {
            headers: { "if-none-match": `"other", ${etag}` },
          });
          expect(listed.status).toBe(304);
          expect(calls).toEqual([4]);

          const weak = await fetch(url, {
            headers: { "if-none-match": `W/${etag}` },
          });
          expect(weak.status).toBe(304);
          await weak.arrayBuffer();
          expect(calls).toEqual([4]);

          const replacement = Buffer.from(
            await new Bun.Image(png).resize(4).png().bytes(),
          );
          await storeArtworkOriginal(
            db,
            item.id,
            {
              type: "poster",
              url: "https://image.example/poster-v2.jpg",
            },
            respondWith(replacement),
          );
          const changed = await fetch(url);
          expect(changed.status).toBe(200);
          const updated = changed.headers.get("etag") ?? "";
          expect(updated).not.toBe(etag);
          await changed.arrayBuffer();
          expect(calls).toEqual([4, 4]);
        });
      });
    }));

  test("evicts the oldest cache entry at the configured bound", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          return {
            bytes: new Uint8Array([width]),
            contentType: "image/x-artwork",
          };
        };
        await withServer(db, { resize, maxCacheEntries: 1 }, async (base) => {
          for (const width of [3, 4, 3])
            await (
              await fetch(`${base}/api/artwork/${row.id}?width=${width}`)
            ).arrayBuffer();
          expect(calls).toEqual([3, 4, 3]);
        });
      });
    }));

  test("requests above the original width share one representation", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          return {
            bytes: new Uint8Array([width]),
            contentType: "image/x-artwork",
          };
        };
        await withServer(db, { resize }, async (base) => {
          const first = await fetch(`${base}/api/artwork/${row.id}?width=20`);
          expect(first.status).toBe(200);
          const etag = first.headers.get("etag") ?? "";
          expect(etag).not.toBe("");
          expect(Buffer.from(await first.arrayBuffer())).toEqual(
            Buffer.from([8]),
          );
          const second = await fetch(`${base}/api/artwork/${row.id}?width=30`);
          expect(second.status).toBe(200);
          expect(second.headers.get("etag")).toBe(etag);
          await second.arrayBuffer();
          expect(calls).toEqual([8]);
        });
      });
    }));

  test("evicts the oldest entry when retained bytes exceed the budget", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          return {
            bytes: new Uint8Array(6),
            contentType: "image/x-artwork",
          };
        };
        await withServer(db, { resize, maxCacheBytes: 10 }, async (base) => {
          for (const width of [3, 4, 3]) {
            const response = await fetch(
              `${base}/api/artwork/${row.id}?width=${width}`,
            );
            expect(response.status).toBe(200);
            await response.arrayBuffer();
          }
          expect(calls).toEqual([3, 4, 3]);
        });
      });
    }));

  test("never retains an entry larger than the byte budget", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          return {
            bytes: new Uint8Array(6),
            contentType: "image/x-artwork",
          };
        };
        await withServer(db, { resize, maxCacheBytes: 5 }, async (base) => {
          for (const width of [4, 4]) {
            const response = await fetch(
              `${base}/api/artwork/${row.id}?width=${width}`,
            );
            expect(response.status).toBe(200);
            await response.arrayBuffer();
          }
          expect(calls).toEqual([4, 4]);
        });
      });
    }));

  test("concurrent misses share one in-flight resize", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        let started!: () => void;
        const resizeStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        let release!: (result: {
          bytes: Uint8Array;
          contentType: string;
        }) => void;
        const gate = new Promise<{
          bytes: Uint8Array;
          contentType: string;
        }>((resolve) => {
          release = resolve;
        });
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          started();
          return gate;
        };
        await withServer(db, { resize }, async (base) => {
          const url = `${base}/api/artwork/${row.id}?width=4`;
          const first = fetch(url);
          const second = fetch(url);
          await resizeStarted;
          expect(calls).toEqual([4]);
          release({
            bytes: new Uint8Array([1, 2, 4]),
            contentType: "image/x-artwork",
          });
          const [one, two] = await Promise.all([first, second]);
          expect(one.status).toBe(200);
          expect(two.status).toBe(200);
          expect(two.headers.get("etag")).toBe(one.headers.get("etag"));
          expect(Buffer.from(await one.arrayBuffer())).toEqual(
            Buffer.from([1, 2, 4]),
          );
          expect(Buffer.from(await two.arrayBuffer())).toEqual(
            Buffer.from([1, 2, 4]),
          );
          expect(calls).toEqual([4]);
          const third = await fetch(url);
          expect(third.status).toBe(200);
          await third.arrayBuffer();
          expect(calls).toEqual([4]);
        });
      });
    }));

  test("different resized output produces a different etag", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const resizeOne: ArtworkResize = async () => ({
          bytes: new Uint8Array([1, 2, 4]),
          contentType: "image/x-artwork",
        });
        const resizeTwo: ArtworkResize = async () => ({
          bytes: new Uint8Array([9, 8, 7]),
          contentType: "image/x-artwork",
        });
        const url = `http://x/api/artwork/${row.id}?width=4`;
        const first = await createArtworkHandler(db, { resize: resizeOne })(
          new Request(url),
        );
        const second = await createArtworkHandler(db, { resize: resizeTwo })(
          new Request(url),
        );
        expect(first?.status).toBe(200);
        expect(second?.status).toBe(200);
        const etagOne = first?.headers.get("etag") ?? "";
        const etagTwo = second?.headers.get("etag") ?? "";
        expect(etagOne).toMatch(/^"[0-9a-f]{64}"$/);
        expect(etagTwo).not.toBe(etagOne);
        await first?.arrayBuffer();
        await second?.arrayBuffer();
      });
    }));

  test("a cold conditional request resizes once before a 304", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const output = new Uint8Array([1, 2, 4]);
        const calls: number[] = [];
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          return { bytes: output, contentType: "image/x-artwork" };
        };
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update("image/x-artwork");
        hasher.update(":");
        hasher.update(output);
        const etag = `"${hasher.digest("hex")}"`;
        const handler = createArtworkHandler(db, { resize });
        const url = `http://x/api/artwork/${row.id}?width=4`;
        const cold = await handler(
          new Request(url, { headers: { "if-none-match": etag } }),
        );
        expect(cold?.status).toBe(304);
        expect(cold?.headers.get("etag")).toBe(etag);
        expect(calls).toEqual([4]);
        const warm = await handler(
          new Request(url, { headers: { "if-none-match": etag } }),
        );
        expect(warm?.status).toBe(304);
        expect(calls).toEqual([4]);
      });
    }));

  test("bounds in-flight artwork work to the concurrency limit", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        const callWaiters: { n: number; resolve: () => void }[] = [];
        const waitForCalls = (n: number) =>
          calls.length >= n
            ? Promise.resolve()
            : new Promise<void>((resolve) => callWaiters.push({ n, resolve }));
        const releases = new Map<number, () => void>();
        const resize: ArtworkResize = (_input, width) => {
          calls.push(width);
          for (let i = callWaiters.length - 1; i >= 0; i -= 1) {
            const waiter = callWaiters[i];
            if (waiter !== undefined && calls.length >= waiter.n) {
              callWaiters.splice(i, 1);
              waiter.resolve();
            }
          }
          return new Promise((resolve) => {
            releases.set(width, () =>
              resolve({
                bytes: new Uint8Array([width]),
                contentType: "image/x-artwork",
              }),
            );
          });
        };
        await withServer(
          db,
          { resize, maxConcurrentResizes: 2 },
          async (base) => {
            const url = (w: number) =>
              `${base}/api/artwork/${row.id}?width=${w}`;
            const pending4 = fetch(url(4));
            const pending5 = fetch(url(5));
            const pending6 = fetch(url(6));
            await waitForCalls(2);
            expect(calls).toHaveLength(2);
            const firstWidth = calls[0];
            if (firstWidth === undefined)
              throw new Error("Resize call missing.");
            releases.get(firstWidth)?.();
            await waitForCalls(3);
            expect(calls).toHaveLength(3);
            for (const release of releases.values()) release();
            const [r4, r5, r6] = await Promise.all([
              pending4,
              pending5,
              pending6,
            ]);
            expect(r4.status).toBe(200);
            expect(r5.status).toBe(200);
            expect(r6.status).toBe(200);
          },
        );
      });
    }));

  test("a rejected in-flight resize does not poison the cache key", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        let attempt = 0;
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          attempt += 1;
          if (attempt === 1) throw new Error("first resize fails");
          return {
            bytes: new Uint8Array([width]),
            contentType: "image/x-artwork",
          };
        };
        await withServer(
          db,
          { resize, maxConcurrentResizes: 1 },
          async (base) => {
            const url = `${base}/api/artwork/${row.id}?width=4`;
            const failed = await fetch(url);
            expect(failed.status).toBe(500);
            const retried = await fetch(url);
            expect(retried.status).toBe(200);
            expect(Buffer.from(await retried.arrayBuffer())).toEqual(
              Buffer.from([4]),
            );
            expect(calls).toEqual([4, 4]);
          },
        );
      });
    }));

  test("bounds the resize queue and frees aborted waiters", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        let resolveGate!: () => void;
        let markStarted!: () => void;
        const resizeStarted = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const gate = new Promise<{
          bytes: Uint8Array;
          contentType: string;
        }>((resolve) => {
          resolveGate = () =>
            resolve({
              bytes: new Uint8Array([1, 2, 4]),
              contentType: "image/x-artwork",
            });
        });
        const resize: ArtworkResize = (_input, width) => {
          calls.push(width);
          markStarted();
          return gate;
        };
        const handler = createArtworkHandler(db, {
          resize,
          maxConcurrentResizes: 1,
          maxQueuedResizes: 0,
        });
        const url = `http://x/api/artwork/${row.id}?width=4`;
        const first = handler(new Request(url));
        await resizeStarted;
        expect(calls).toEqual([4]);
        const busy = await handler(new Request(url));
        expect(busy?.status).toBe(503);
        resolveGate();
        const done = await first;
        expect(done?.status).toBe(200);
        expect(
          Buffer.from((await done?.arrayBuffer()) ?? new ArrayBuffer(0)),
        ).toEqual(Buffer.from([1, 2, 4]));
        expect(calls).toEqual([4]);
      });
    }));

  test("an aborted queued request frees its slot for a later request", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const calls: number[] = [];
        let resolveGate!: () => void;
        let markStarted!: () => void;
        const resizeStarted = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const gate = new Promise<{
          bytes: Uint8Array;
          contentType: string;
        }>((resolve) => {
          resolveGate = () =>
            resolve({
              bytes: new Uint8Array([9]),
              contentType: "image/x-artwork",
            });
        });
        const resize: ArtworkResize = (_input, width) => {
          calls.push(width);
          markStarted();
          return gate;
        };
        const handler = createArtworkHandler(db, {
          resize,
          maxConcurrentResizes: 1,
          maxQueuedResizes: 1,
        });
        const url = `http://x/api/artwork/${row.id}?width=4`;
        const first = handler(new Request(url));
        await resizeStarted;
        expect(calls).toEqual([4]);
        const controller = new AbortController();
        const aborted = handler(
          new Request(url, { signal: controller.signal }),
        );
        await Bun.sleep(50);
        controller.abort();
        const rejected = await aborted;
        expect(rejected?.status).toBe(503);
        const third = handler(
          new Request(`http://x/api/artwork/${row.id}?width=3`),
        );
        await Bun.sleep(50);
        resolveGate();
        const [firstDone, thirdDone] = await Promise.all([first, third]);
        expect(firstDone?.status).toBe(200);
        expect(thirdDone?.status).toBe(200);
        expect(
          Buffer.from((await thirdDone?.arrayBuffer()) ?? new ArrayBuffer(0)),
        ).toEqual(Buffer.from([9]));
        expect(calls).toEqual([4, 3]);
      });
    }));

  test("rejects invalid cache bounds", () =>
    withDatabase(async (db) => {
      for (const maxCacheBytes of [0, -1, 1.5, Number.NaN, Number.MAX_VALUE]) {
        expect(() => createArtworkHandler(db, { maxCacheBytes })).toThrow(
          "Invalid artwork cache size.",
        );
      }
      for (const maxConcurrentResizes of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.MAX_VALUE,
      ]) {
        expect(() =>
          createArtworkHandler(db, { maxConcurrentResizes }),
        ).toThrow("Invalid artwork cache size.");
      }
      for (const maxQueuedResizes of [-1, 1.5, Number.NaN, Number.MAX_VALUE]) {
        expect(() => createArtworkHandler(db, { maxQueuedResizes })).toThrow(
          "Invalid artwork cache size.",
        );
      }
      expect(() =>
        createArtworkHandler(db, { maxQueuedResizes: 0 }),
      ).not.toThrow();
    }));

  test("enforces artworkRequiresAuth with a real credential", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        await withServer(db, {}, async (base) => {
          const url = `${base}/api/artwork/${row.id}?width=4`;
          const open = await fetch(url);
          expect(open.status).toBe(200);
          const oldTag = open.headers.get("etag") ?? "";
          await open.arrayBuffer();
          await db.insert(settings).values({
            key: "auth",
            value: { artworkRequiresAuth: true },
          });
          const anonymous = await fetch(url);
          expect(anonymous.status).toBe(401);
          expect(await anonymous.json()).toEqual({
            error: {
              code: "UNAUTHENTICATED",
              message: "Authentication required.",
            },
          });
          const staleTag = await fetch(url, {
            headers: { "if-none-match": oldTag },
          });
          expect(staleTag.status).toBe(401);
          const malformed = await fetch(url, {
            headers: { authorization: "Bearer nope" },
          });
          expect(malformed.status).toBe(401);
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "secret",
          });
          const { token } = await createApiKey(db, admin.id, "artwork-test");
          const authed = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(authed.status).toBe(200);
          expect(authed.headers.get("cache-control")).toBe(
            "private, max-age=0, must-revalidate",
          );
          await authed.arrayBuffer();
          const authed304 = await fetch(url, {
            headers: {
              authorization: `Bearer ${token}`,
              "if-none-match": oldTag,
            },
          });
          expect(authed304.status).toBe(304);
          expect(authed304.headers.get("cache-control")).toBe(
            "private, max-age=0, must-revalidate",
          );
        });
      });
    }));

  test("an already-aborted request does not consume a resize slot", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const resizes: number[] = [];
        const resize: ArtworkResize = async (input, width) => {
          resizes.push(width);
          return { bytes: input, contentType: "image/x-artwork" };
        };
        const handler = createArtworkHandler(db, { resize });
        const controller = new AbortController();
        controller.abort();
        const aborted = await handler(
          new Request(`http://local/api/artwork/${row.id}?width=4`, {
            signal: controller.signal,
          }),
        );
        expect(aborted?.status).toBe(503);
        expect(await aborted?.json()).toEqual({
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Artwork service is busy.",
          },
        });
        expect(resizes).toEqual([]);
        const normal = await handler(
          new Request(`http://local/api/artwork/${row.id}?width=4`),
        );
        expect(normal?.status).toBe(200);
        await normal?.arrayBuffer();
        expect(resizes).toEqual([4]);
      });
    }));

  test("a denied authenticated caller cannot view artwork", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item, row } = await seed(db, root, png);
        await db.insert(settings).values({
          key: "auth",
          value: { artworkRequiresAuth: true },
        });
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const viewer = await createLocalUser(db, admin.id, {
          username: "viewer",
          password: "viewer-pass",
        });
        await db.insert(libraryAccess).values({
          libraryId: item.libraryId,
          userId: viewer.id,
          allowed: false,
        });
        const denied = await createApiKey(db, viewer.id, "denied");
        const allowed = await createApiKey(db, admin.id, "allowed");
        const resizes: number[] = [];
        const resize: ArtworkResize = async (input, width) => {
          resizes.push(width);
          return { bytes: input, contentType: "image/x-artwork" };
        };
        await withServer(db, { resize }, async (base) => {
          const url = `${base}/api/artwork/${row.id}?width=4`;
          const forbidden = await fetch(url, {
            headers: { authorization: `Bearer ${denied.token}` },
          });
          expect(forbidden.status).toBe(403);
          expect(await forbidden.json()).toEqual({
            error: { code: "FORBIDDEN", message: "Permission denied." },
          });
          expect(resizes).toEqual([]);
          const granted = await fetch(url, {
            headers: { authorization: `Bearer ${allowed.token}` },
          });
          expect(granted.status).toBe(200);
          await granted.arrayBuffer();
          expect(resizes).toEqual([4]);
        });
      });
    }));

  test("a deselected artwork row answers 404", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        await db
          .update(artwork)
          .set({ selected: false })
          .where(eq(artwork.id, row.id));
        await withServer(db, {}, async (base) => {
          const response = await fetch(`${base}/api/artwork/${row.id}?width=4`);
          expect(response.status).toBe(404);
        });
      });
    }));

  test("validates the path, method and width", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const handler = createArtworkHandler(db);
        expect(
          await handler(new Request("http://x/api/artwork")),
        ).toBeUndefined();
        expect(
          await handler(new Request("http://x/api/items")),
        ).toBeUndefined();
        await withServer(db, {}, async (base) => {
          const badWidth = [
            "",
            "?width=",
            "?width=0",
            "?width=-1",
            "?width=4.5",
            "?width= 4",
            "?width=+4",
            "?width=abc",
            "?width=4097",
            "?width=99999999999999999999",
            "?width=4&width=5",
          ];
          for (const query of badWidth) {
            const response = await fetch(
              `${base}/api/artwork/${row.id}${query}`,
            );
            expect(response.status).toBe(400);
          }
          expect(
            (await fetch(`${base}/api/artwork/not-a-uuid?width=4`)).status,
          ).toBe(400);
          expect((await fetch(`${base}/api/artwork/`)).status).toBe(400);
          expect(
            (await fetch(`${base}/api/artwork/${row.id}/extra?width=4`)).status,
          ).toBe(400);
          expect(
            (await fetch(`${base}/api/artwork/${Bun.randomUUIDv7()}?width=4`))
              .status,
          ).toBe(404);
          const posted = await fetch(`${base}/api/artwork/${row.id}?width=4`, {
            method: "POST",
          });
          expect(posted.status).toBe(405);
          expect(posted.headers.get("allow")).toBe("GET");
        });
      });
    }));

  test("returns a generic 500 for resize and storage failures", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { row } = await seed(db, root, png);
        const resize: ArtworkResize = async () => {
          throw new Error("resize internal detail must stay hidden");
        };
        await withServer(db, { resize }, async (base) => {
          const failed = await fetch(`${base}/api/artwork/${row.id}?width=4`);
          expect(failed.status).toBe(500);
          const body = (await failed.json()) as {
            error: { code: string; message: string };
          };
          expect(body.error.code).toBe("INTERNAL_ERROR");
          expect(body.error.message).toBe("Artwork request failed.");
          expect(JSON.stringify(body)).not.toContain("resize internal");
        });
        await db
          .update(artwork)
          .set({ storageKey: "../outside.png" })
          .where(eq(artwork.id, row.id));
        await withServer(db, {}, async (base) => {
          const corrupt = await fetch(`${base}/api/artwork/${row.id}?width=4`);
          expect(corrupt.status).toBe(500);
        });
      });
    }));
});
