import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { startApiServer } from "../api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork, libraries, settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { type ArtworkResize, createArtworkHandler } from "./artwork-http.ts";
import { storeArtworkOriginal } from "./artwork-store.ts";

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

async function seed(db: Database, root: string, bytes: Uint8Array) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: root })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  const item = await insertItem(db, {
    libraryId: library.id,
    kind: "movie",
    title: "Alien",
    year: 1979,
    canonicalFolder: "Alien (1979)",
    extension: {},
  });
  const row = await storeArtworkOriginal(
    db,
    item.id,
    poster,
    respondWith(bytes),
  );
  return { item, row };
}

async function withServer<T>(
  db: Database,
  options: {
    resize?: ArtworkResize;
    maxCacheEntries?: number;
    maxCacheBytes?: number;
  },
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
  test("serves a real sharp resize of a stored original", () =>
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
          const meta = await sharp(bytes).metadata();
          expect({ width: meta.width, height: meta.height }).toEqual({
            width: 4,
            height: 4,
          });

          const enlarged = await fetch(
            `${base}/api/artwork/${row.id}?width=20`,
          );
          expect(enlarged.status).toBe(200);
          const big = await sharp(
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
        const resize: ArtworkResize = async (_input, width) => {
          calls.push(width);
          return {
            bytes: new Uint8Array([1, 2, width]),
            contentType: "image/x-artwork",
          };
        };
        await withServer(db, { resize }, async (base) => {
          const url = `${base}/api/artwork/${row.id}?width=4`;
          const first = await fetch(url);
          expect(first.status).toBe(200);
          const etag = first.headers.get("etag") ?? "";
          expect(etag.startsWith('"')).toBe(true);
          await first.arrayBuffer();

          const second = await fetch(url);
          expect(second.status).toBe(200);
          expect(second.headers.get("etag")).toBe(etag);
          expect(Buffer.from(await second.arrayBuffer())).toEqual(
            Buffer.from([1, 2, 4]),
          );
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
          expect(weak.status).toBe(200);
          await weak.arrayBuffer();
          expect(calls).toEqual([4]);

          const replacement = await sharp({
            create: {
              width: 4,
              height: 4,
              channels: 3,
              background: { r: 0, g: 255, b: 0 },
            },
          })
            .png()
            .toBuffer();
          await storeArtworkOriginal(
            db,
            item.id,
            poster,
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
        await withServer(db, { resize }, async (base) => {
          const url = `${base}/api/artwork/${row.id}?width=4`;
          const failed = await fetch(url);
          expect(failed.status).toBe(500);
          const retried = await fetch(url);
          expect(retried.status).toBe(200);
          expect(Buffer.from(await retried.arrayBuffer())).toEqual(
            Buffer.from([4]),
          );
          expect(calls).toEqual([4, 4]);
        });
      });
    }));

  test("rejects invalid cache bounds", () =>
    withDatabase(async (db) => {
      for (const maxCacheBytes of [0, -1, 1.5, Number.NaN, Number.MAX_VALUE]) {
        expect(() => createArtworkHandler(db, { maxCacheBytes })).toThrow(
          "Invalid artwork cache size.",
        );
      }
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
          throw new Error("sharp internal detail must stay hidden");
        };
        await withServer(db, { resize }, async (base) => {
          const failed = await fetch(`${base}/api/artwork/${row.id}?width=4`);
          expect(failed.status).toBe(500);
          const body = (await failed.json()) as {
            error: { code: string; message: string };
          };
          expect(body.error.code).toBe("INTERNAL_ERROR");
          expect(body.error.message).toBe("Artwork request failed.");
          expect(JSON.stringify(body)).not.toContain("sharp internal");
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
