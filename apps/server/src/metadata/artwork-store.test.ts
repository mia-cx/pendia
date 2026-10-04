import { describe, expect, spyOn, test } from "bun:test";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  type DeletedArtworkFile,
  deleteItemSubtree,
  insertItem,
} from "../db/tree.ts";
import { deleteLibrary } from "../libraries/service.ts";
import type { ArtworkOpen, ArtworkStoreConfig } from "./artwork-backends.ts";
import {
  readArtworkOriginal,
  removeArtworkFiles,
  removeSelectedArtwork,
  storeArtworkOriginal,
} from "./artwork-store.ts";
import { s3Url, testS3Store } from "./testing.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP4y8CAFWEXHbQSAPZwP0G2GkFNAAAAAElFTkSuQmCC",
  "base64",
);

const poster = {
  type: "poster",
  url: "https://image.example/poster.jpg",
} as const;

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typed = new Uint8Array(4 + data.byteLength);
  typed.set(new TextEncoder().encode(type));
  typed.set(data, 4);
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  out.set(typed, 4);
  view.setUint32(8 + data.byteLength, Bun.hash.crc32(typed));
  return out;
}

/** A PNG that declares its geometry in the header and carries no pixels. */
function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", ihdr),
      pngChunk("IEND", new Uint8Array(0)),
    ]),
  );
}

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
    canonicalFolder: "Alien (1979)",
    extension: {},
  });
  await mkdir(join(rootPath, item.canonicalFolder), { recursive: true });
  return { library, item };
}

function mockRequest(responder: (url: string) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const request = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    return responder(url);
  }) as typeof fetch;
  return { calls, request };
}

/** Proves a removed selection, a deleted Item and a deleted Library each take their original along. */
async function expectRemovals(
  db: Database,
  root: string,
  store: ArtworkStoreConfig,
  exists: (storageKey: string) => Promise<boolean>,
) {
  const { library, item } = await fixture(db, root);
  const { request } = mockRequest(() => new Response(png));
  const selected = await storeArtworkOriginal(db, item.id, poster, request, {
    store,
  });
  expect(await removeSelectedArtwork(db, item.id, "poster", store)).toBe(true);
  expect(await exists(selected.storageKey)).toBe(false);

  const owned = await storeArtworkOriginal(db, item.id, poster, request, {
    store,
  });
  const deletedArtwork: DeletedArtworkFile[] = [];
  await deleteItemSubtree(db, item.id, deletedArtwork);
  await removeArtworkFiles(deletedArtwork, store);
  expect(await exists(owned.storageKey)).toBe(false);

  const sibling = await insertItem(db, {
    libraryId: library.id,
    kind: "movie",
    title: "Aliens",
    year: 1986,
    canonicalFolder: "Aliens (1986)",
    extension: {},
  });
  const kept = await storeArtworkOriginal(db, sibling.id, poster, request, {
    store,
  });
  expect(await exists(kept.storageKey)).toBe(true);
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  await deleteLibrary(db, admin.id, library.id, store);
  expect(await exists(kept.storageKey)).toBe(false);
}

describe.skipIf(!databaseUrl)("storeArtworkOriginal", () => {
  test("stores the poster bytes in the Item's colocated artwork folder", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { calls, request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(poster.url);
        expect(calls[0]?.init?.headers).toEqual({ accept: "image/*" });
        expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
        expect(row).toMatchObject({
          itemId: item.id,
          versionId: null,
          type: "poster",
          sourceUrl: poster.url,
          backend: "colocated",
          width: 8,
          height: 8,
          selected: true,
        });
        expect(row.storageKey).toMatch(
          new RegExp(
            `^Alien \\(1979\\)/\\.pendia/artwork/${row.id}\\.[0-9a-f-]{36}$`,
          ),
        );
        const stored = await readFile(join(root, row.storageKey));
        expect(stored).toEqual(png);
        expect(await db.select().from(artwork)).toHaveLength(1);
      });
    }));

  test("reuses the selected colocated row and replaces its bytes", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const replacement = Buffer.from(
          await new Bun.Image(png).resize(4).png().bytes(),
        );
        const { calls, request } = mockRequest((url) =>
          url.endsWith("new.jpg")
            ? new Response(replacement)
            : new Response(png),
        );
        const first = await storeArtworkOriginal(db, item.id, poster, request);
        const second = await storeArtworkOriginal(
          db,
          item.id,
          { type: "poster", url: "https://image.example/new.jpg" },
          request,
        );
        expect(second.id).toBe(first.id);
        expect(second.storageKey).not.toBe(first.storageKey);
        expect(second.storageKey).toMatch(
          new RegExp(
            `^Alien \\(1979\\)/\\.pendia/artwork/${first.id}\\.[0-9a-f-]{36}$`,
          ),
        );
        expect(second.sourceUrl).toBe("https://image.example/new.jpg");
        expect(second).toMatchObject({ width: 4, height: 4 });
        expect(calls).toHaveLength(2);
        expect(await db.select().from(artwork)).toHaveLength(1);
        await expect(access(join(root, first.storageKey))).rejects.toThrow();
        expect(await readFile(join(root, second.storageKey))).toEqual(
          replacement,
        );
        const names = await readdir(
          join(root, item.canonicalFolder, ".pendia", "artwork"),
        );
        expect(names).toHaveLength(1);
        expect(`${item.canonicalFolder}/.pendia/artwork/${names[0]}`).toBe(
          second.storageKey,
        );
      });
    }));

  test("returns the selected row without a request for the same source", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { calls, request } = mockRequest(() => new Response(png));
        const first = await storeArtworkOriginal(db, item.id, poster, request);
        expect(calls).toHaveLength(1);
        const second = await storeArtworkOriginal(db, item.id, poster, request);
        expect(second).toEqual(first);
        expect(calls).toHaveLength(1);
        expect(await db.select().from(artwork)).toHaveLength(1);
        expect(await readFile(join(root, first.storageKey))).toEqual(png);
      });
    }));

  test("concurrent stores for one item serialize on the item lock", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        let release = () => {};
        let allArrived = () => {};
        const releaseGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const arrivedGate = new Promise<void>((resolve) => {
          allArrived = resolve;
        });
        let arrived = 0;
        const request = (async (
          _input: string | URL | Request,
          _init?: RequestInit,
        ) => {
          arrived += 1;
          if (arrived === 2) allArrived();
          await releaseGate;
          return new Response(png);
        }) as typeof fetch;
        const first = storeArtworkOriginal(db, item.id, poster, request);
        const second = storeArtworkOriginal(db, item.id, poster, request);
        await arrivedGate;
        release();
        const [rowA, rowB] = await Promise.all([first, second]);
        expect(rowB.id).toBe(rowA.id);
        expect(await db.select().from(artwork)).toHaveLength(1);
        const [final] = await db.select().from(artwork);
        if (!final) throw new Error("Stored artwork missing.");
        const names = await readdir(
          join(root, item.canonicalFolder, ".pendia", "artwork"),
        );
        expect(names).toHaveLength(1);
        expect(`${item.canonicalFolder}/.pendia/artwork/${names[0]}`).toBe(
          final.storageKey,
        );
      });
    }));

  test("an invalid image response changes neither file nor row", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const first = await storeArtworkOriginal(db, item.id, poster, request);
        const corrupt = mockRequest(
          () => new Response("<html>not an image</html>"),
        );
        await expect(
          storeArtworkOriginal(
            db,
            item.id,
            { type: "poster", url: "https://image.example/bad.jpg" },
            corrupt.request,
          ),
        ).rejects.toThrow("Invalid artwork response.");
        const [row] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.id, first.id));
        expect(row).toMatchObject({
          sourceUrl: poster.url,
          width: 8,
          height: 8,
          selected: true,
        });
        expect(await readFile(join(root, first.storageKey))).toEqual(png);
        const names = await readdir(
          join(root, item.canonicalFolder, ".pendia", "artwork"),
        );
        expect(names).toHaveLength(1);
        expect(names[0]?.startsWith(`${first.id}.`)).toBe(true);
      });
    }));

  test("an image that decodes metadata but not pixels leaves state untouched", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const first = await storeArtworkOriginal(db, item.id, poster, request);
        const truncated = png.subarray(0, 70);
        const meta = await new Bun.Image(truncated).metadata();
        expect({ width: meta.width, height: meta.height }).toEqual({
          width: 8,
          height: 8,
        });
        const corrupt = mockRequest(() => new Response(Buffer.from(truncated)));
        await expect(
          storeArtworkOriginal(
            db,
            item.id,
            { type: "poster", url: "https://image.example/truncated.png" },
            corrupt.request,
          ),
        ).rejects.toThrow("Invalid artwork response.");
        const [row] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.id, first.id));
        expect(row).toMatchObject({
          sourceUrl: poster.url,
          storageKey: first.storageKey,
          width: 8,
          height: 8,
          selected: true,
        });
        expect(await readFile(join(root, first.storageKey))).toEqual(png);
      });
    }));

  test("a declared geometry outside the bounds leaves no row or file", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const decode = spyOn(Bun.Image.prototype, "resize").mockImplementation(
          () => {
            throw new Error("Unexpected image decode.");
          },
        );
        try {
          // Each header trips one limit: width, pixel count, aspect ratio.
          for (const body of [
            pngHeader(8193, 500),
            pngHeader(8000, 6000),
            pngHeader(2100, 100),
          ]) {
            const { request } = mockRequest(() => new Response(body));
            await expect(
              storeArtworkOriginal(db, item.id, poster, request),
            ).rejects.toThrow("Invalid artwork response.");
          }
          expect(decode).not.toHaveBeenCalled();
        } finally {
          decode.mockRestore();
        }
        expect(await db.select().from(artwork)).toHaveLength(0);
        await expect(
          access(join(root, "Alien (1979)", ".pendia")),
        ).rejects.toThrow();
      });
    }));

  test("a declared Content-Length over the limit rejects before retaining", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4));
          },
          cancel() {
            cancelled = true;
          },
        });
        const { calls, request } = mockRequest(
          () =>
            new Response(stream, {
              headers: { "content-length": String(png.length + 1) },
            }),
        );
        await expect(
          storeArtworkOriginal(db, item.id, poster, request, {
            maxDownloadBytes: png.length,
          }),
        ).rejects.toThrow("Artwork response too large.");
        expect(cancelled).toBe(true);
        expect(calls).toHaveLength(1);
        expect(await db.select().from(artwork)).toHaveLength(0);
        await expect(
          access(join(root, "Alien (1979)", ".pendia")),
        ).rejects.toThrow();
      });
    }));

  test("a stream crossing the limit cancels the reader and rejects", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(3));
            controller.enqueue(new Uint8Array(3));
          },
          cancel() {
            cancelled = true;
          },
        });
        const { request } = mockRequest(() => new Response(stream));
        await expect(
          storeArtworkOriginal(db, item.id, poster, request, {
            maxDownloadBytes: 4,
          }),
        ).rejects.toThrow("Artwork response too large.");
        expect(cancelled).toBe(true);
        expect(await db.select().from(artwork)).toHaveLength(0);
        await expect(
          access(join(root, "Alien (1979)", ".pendia")),
        ).rejects.toThrow();
      });
    }));

  test("rejects invalid download limits before any request", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { calls, request } = mockRequest(() => new Response(png));
        for (const maxDownloadBytes of [0, -1, 1.5, Number.NaN]) {
          await expect(
            storeArtworkOriginal(db, item.id, poster, request, {
              maxDownloadBytes,
            }),
          ).rejects.toThrow("Invalid artwork download limit.");
        }
        expect(calls).toHaveLength(0);
        expect(await db.select().from(artwork)).toHaveLength(0);
      });
    }));

  test("a rolled-back replacement keeps the old row and bytes", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const first = await storeArtworkOriginal(db, item.id, poster, request);
        await db.execute(sql`
          alter table artwork
          add constraint reject_new_source
          check (source_url <> 'https://image.example/new.jpg')
        `);
        await expect(
          storeArtworkOriginal(
            db,
            item.id,
            { type: "poster", url: "https://image.example/new.jpg" },
            request,
          ),
        ).rejects.toThrow();
        const [row] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.id, first.id));
        expect(row).toMatchObject({
          sourceUrl: poster.url,
          storageKey: first.storageKey,
          width: 8,
          height: 8,
          selected: true,
        });
        expect(await readFile(join(root, first.storageKey))).toEqual(png);
        const names = await readdir(
          join(root, item.canonicalFolder, ".pendia", "artwork"),
        );
        const basename = first.storageKey.split("/").pop();
        if (basename === undefined) throw new Error("Basename missing.");
        expect(names).toEqual([basename]);
      });
    }));

  test("round-trips a poster through the configured path", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        await withTempRoot(async (path) => {
          const store = { backend: "configured-path", path } as const;
          const { item } = await fixture(db, root);
          const { request } = mockRequest(() => new Response(png));
          const row = await storeArtworkOriginal(db, item.id, poster, request, {
            store,
          });
          expect(row.backend).toBe("configured-path");
          expect(row.storageKey).toMatch(
            new RegExp(`^${row.id}\\.[0-9a-f-]{36}$`),
          );
          expect(await readFile(join(path, row.storageKey))).toEqual(png);
          await expect(
            access(join(root, "Alien (1979)", ".pendia")),
          ).rejects.toThrow();
          const original = await readArtworkOriginal(db, row.id, store);
          expect(Buffer.from(original?.bytes ?? [])).toEqual(png);
          expect(await readArtworkOriginal(db, row.id)).toBeNull();
        });
      });
    }));

  test("removes configured-path originals with their selection, Item and Library", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        await withTempRoot(async (path) => {
          await expectRemovals(
            db,
            root,
            { backend: "configured-path", path },
            (storageKey) =>
              access(join(path, storageKey)).then(
                () => true,
                () => false,
              ),
          );
        });
      });
    }));

  // Root ignores directory permissions, so it cannot fake a read-only share.
  test.skipIf(process.getuid?.() === 0)(
    "a read-only Item folder falls back to the configured path",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await withTempRoot(async (root) => {
          await withTempRoot(async (path) => {
            const { item } = await fixture(db, root);
            const folder = join(root, item.canonicalFolder);
            const { request } = mockRequest(() => new Response(png));
            await chmod(folder, 0o555);
            try {
              await expect(
                storeArtworkOriginal(db, item.id, poster, request, {
                  store: { backend: "colocated" },
                }),
              ).rejects.toMatchObject({ code: "EACCES" });
              const store = { backend: "colocated", path } as const;
              const row = await storeArtworkOriginal(
                db,
                item.id,
                poster,
                request,
                { store },
              );
              expect(row.backend).toBe("configured-path");
              expect(await readFile(join(path, row.storageKey))).toEqual(png);
              const original = await readArtworkOriginal(db, row.id, store);
              expect(Buffer.from(original?.bytes ?? [])).toEqual(png);
            } finally {
              await chmod(folder, 0o755);
            }
          });
        });
      }),
  );

  test("a replacement keeps the row id and removes the old original from its backend", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        await withTempRoot(async (path) => {
          const { item } = await fixture(db, root);
          const { request } = mockRequest(() => new Response(png));
          const old = await storeArtworkOriginal(db, item.id, poster, request);
          const row = await storeArtworkOriginal(
            db,
            item.id,
            { type: "poster", url: "https://image.example/new.png" },
            request,
            { store: { backend: "configured-path", path } },
          );
          expect(row.id).toBe(old.id);
          expect(row.backend).toBe("configured-path");
          await expect(access(join(root, old.storageKey))).rejects.toThrow();
          expect(await readFile(join(path, row.storageKey))).toEqual(png);
          expect(await db.select().from(artwork)).toHaveLength(1);
        });
      });
    }));

  test("a non-2xx response fails without a row or file", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { calls, request } = mockRequest(
          () => new Response("unavailable", { status: 503 }),
        );
        await expect(
          storeArtworkOriginal(db, item.id, poster, request),
        ).rejects.toThrow("Artwork request failed with status 503.");
        expect(calls).toHaveLength(1);
        expect(await db.select().from(artwork)).toHaveLength(0);
        await expect(
          access(join(root, "Alien (1979)", ".pendia")),
        ).rejects.toThrow();
      });
    }));

  test("an invalid reused storage key rejects before escaping the root", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const escaped = `../escape-${Bun.randomUUIDv7()}`;
        const [row] = await db
          .insert(artwork)
          .values({
            itemId: item.id,
            versionId: null,
            type: "poster",
            sourceUrl: poster.url,
            backend: "colocated",
            storageKey: escaped,
            selected: true,
          })
          .returning();
        if (!row) throw new Error("Fixture artwork missing.");
        const { request } = mockRequest(() => new Response(png));
        for (const key of [escaped, "/absolute-target", "folder/./inner"]) {
          await db
            .update(artwork)
            .set({ storageKey: key })
            .where(eq(artwork.id, row.id));
          await expect(
            storeArtworkOriginal(db, item.id, poster, request),
          ).rejects.toThrow("Invalid artwork storage path.");
        }
        await expect(
          access(join(dirname(root), escaped.slice(3))),
        ).rejects.toThrow();
        expect(
          (await db.select().from(artwork).where(eq(artwork.id, row.id)))[0]
            ?.selected,
        ).toBe(true);
      });
    }));

  test("a .pendia symlink is rejected instead of followed outside the root", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) =>
        withTempRoot(async (outside) => {
          const { item } = await fixture(db, root);
          await symlink(outside, join(root, item.canonicalFolder, ".pendia"));
          const { calls, request } = mockRequest(() => new Response(png));
          await expect(
            storeArtworkOriginal(db, item.id, poster, request),
          ).rejects.toThrow("Invalid artwork storage path.");
          expect(calls).toHaveLength(1);
          expect(await db.select().from(artwork)).toHaveLength(0);
          expect(await readdir(outside)).toHaveLength(0);
        }),
      );
    }));

  test("a request timeout leaves no row or file", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const request = (async (
          _input: string | URL | Request,
          init?: RequestInit,
        ) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === null || signal === undefined) {
              reject(new Error("Missing request signal."));
              return;
            }
            if (signal.aborted) {
              reject(new Error("The operation timed out."));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new Error("The operation timed out.")),
              { once: true },
            );
          })) as typeof fetch;
        await expect(
          storeArtworkOriginal(db, item.id, poster, request, { timeoutMs: 1 }),
        ).rejects.toThrow("timed out");
        expect(await db.select().from(artwork)).toHaveLength(0);
        await expect(
          access(join(root, "Alien (1979)", ".pendia")),
        ).rejects.toThrow();
      });
    }));

  test("rejects invalid request timeouts before any request", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { calls, request } = mockRequest(() => new Response(png));
        for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.MAX_VALUE]) {
          await expect(
            storeArtworkOriginal(db, item.id, poster, request, { timeoutMs }),
          ).rejects.toThrow("Invalid artwork request timeout.");
        }
        expect(calls).toHaveLength(0);
        expect(await db.select().from(artwork)).toHaveLength(0);
      });
    }));

  test("a missing item throws NOT_FOUND", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { calls, request } = mockRequest(() => new Response(png));
      const error = await storeArtworkOriginal(
        db,
        Bun.randomUUIDv7(),
        poster,
        request,
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("NOT_FOUND");
      expect(calls).toHaveLength(0);
    }));
});

describe.skipIf(!databaseUrl)("readArtworkOriginal", () => {
  test("reads the stored bytes and artwork row", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request);
        const original = await readArtworkOriginal(db, row.id);
        expect(original?.artwork.id).toBe(row.id);
        expect(Buffer.from(original?.bytes ?? [])).toEqual(png);
      });
    }));

  test("returns null for a missing id and a missing file", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        expect(await readArtworkOriginal(db, Bun.randomUUIDv7())).toBeNull();
        const { request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request);
        await rm(join(root, row.storageKey));
        expect(await readArtworkOriginal(db, row.id)).toBeNull();
      });
    }));

  test("returns null when a stored artwork parent disappeared", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request);
        await rm(join(root, item.canonicalFolder, ".pendia"), {
          recursive: true,
        });
        expect(await readArtworkOriginal(db, row.id)).toBeNull();
        const second = await storeArtworkOriginal(db, item.id, poster, request);
        await rm(join(root, item.canonicalFolder), { recursive: true });
        expect(await readArtworkOriginal(db, second.id)).toBeNull();
      });
    }));

  test("retries while stored generations are replaced before open", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const first = await storeArtworkOriginal(db, item.id, poster, request);
        // Two distinct valid PNGs for the two racing replacements.
        const replacements = await Promise.all(
          [4, 6].map(async (width) =>
            Buffer.from(await new Bun.Image(png).resize(width).png().bytes()),
          ),
        );
        const paths: string[] = [];
        const openFile: ArtworkOpen = async (path, flags) => {
          paths.push(path);
          const replacement = replacements[paths.length - 1];
          if (replacement !== undefined)
            await storeArtworkOriginal(
              db,
              item.id,
              {
                type: "poster",
                url: `https://image.example/new-${paths.length}.png`,
              },
              mockRequest(() => new Response(replacement)).request,
            );
          return open(path, flags);
        };
        const original = await readArtworkOriginal(
          db,
          first.id,
          { backend: "colocated" },
          openFile,
        );
        expect(paths).toHaveLength(3);
        expect(paths[0]).not.toBe(paths[1]);
        expect(paths[1]).not.toBe(paths[2]);
        expect(original?.artwork.id).toBe(first.id);
        expect(original?.artwork.storageKey).not.toBe(first.storageKey);
        expect(original?.artwork.sourceUrl).toBe(
          "https://image.example/new-2.png",
        );
        const finalReplacement = replacements[1];
        if (finalReplacement === undefined)
          throw new Error("Replacement missing.");
        expect(Buffer.from(original?.bytes ?? [])).toEqual(finalReplacement);
      });
    }));

  test("returns null for a deselected artwork row", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request);
        await db
          .update(artwork)
          .set({ selected: false })
          .where(eq(artwork.id, row.id));
        expect(await readArtworkOriginal(db, row.id)).toBeNull();
      });
    }));

  test("returns null for a row whose backend this process lacks", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const [row] = await db
          .insert(artwork)
          .values({
            itemId: item.id,
            versionId: null,
            type: "poster",
            sourceUrl: poster.url,
            backend: "configured-path",
            storageKey: "elsewhere/poster.jpg",
            selected: true,
          })
          .returning();
        if (!row) throw new Error("Fixture artwork missing.");
        expect(await readArtworkOriginal(db, row.id)).toBeNull();
      });
    }));

  test("rejects a final-file symlink instead of reading outside the root", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) =>
        withTempRoot(async (outside) => {
          const { item } = await fixture(db, root);
          const outsideFile = join(outside, "secret.png");
          const [row] = await db
            .insert(artwork)
            .values({
              itemId: item.id,
              versionId: null,
              type: "poster",
              sourceUrl: poster.url,
              backend: "colocated",
              storageKey: `Alien (1979)/.pendia/artwork/${Bun.randomUUIDv7()}`,
              selected: true,
            })
            .returning();
          if (!row) throw new Error("Fixture artwork missing.");
          const target = join(root, row.storageKey);
          await mkdir(dirname(target), { recursive: true });
          await rm(target, { force: true });
          await symlink(outsideFile, target);
          await writeFile(outsideFile, png);
          await expect(readArtworkOriginal(db, row.id)).rejects.toThrow(
            "Invalid artwork storage path.",
          );
        }),
      );
    }));

  test("rejects a FIFO at the original instead of waiting for a writer", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request);
        const target = join(root, row.storageKey);
        await rm(target);
        expect(Bun.spawnSync(["mkfifo", target]).exitCode).toBe(0);
        await expect(readArtworkOriginal(db, row.id)).rejects.toThrow(
          "Invalid artwork storage path.",
        );
      });
    }));

  test("rejects a .pendia symlink in read mode", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) =>
        withTempRoot(async (outside) => {
          const { item } = await fixture(db, root);
          await symlink(outside, join(root, item.canonicalFolder, ".pendia"));
          const [row] = await db
            .insert(artwork)
            .values({
              itemId: item.id,
              versionId: null,
              type: "poster",
              sourceUrl: poster.url,
              backend: "colocated",
              storageKey: `Alien (1979)/.pendia/artwork/${Bun.randomUUIDv7()}`,
              selected: true,
            })
            .returning();
          if (!row) throw new Error("Fixture artwork missing.");
          await expect(readArtworkOriginal(db, row.id)).rejects.toThrow(
            "Invalid artwork storage path.",
          );
        }),
      );
    }));
});

describe.skipIf(!databaseUrl || !s3Url)("S3 artwork store", () => {
  test("round-trips a poster and removes the replaced object", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const store = testS3Store();
        const { item } = await fixture(db, root);
        const { request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request, {
          store,
        });
        expect(row.backend).toBe("s3");
        expect(row.storageKey).toMatch(
          new RegExp(`^${row.id}\\.[0-9a-f-]{36}$`),
        );
        const original = await readArtworkOriginal(db, row.id, store);
        expect(Buffer.from(original?.bytes ?? [])).toEqual(png);

        const replaced = await storeArtworkOriginal(
          db,
          item.id,
          { type: "poster", url: "https://image.example/new.png" },
          request,
          { store },
        );
        expect(replaced.id).toBe(row.id);
        expect(await store.client.exists(row.storageKey)).toBe(false);
        expect(await store.client.exists(replaced.storageKey)).toBe(true);
        await store.client.delete(replaced.storageKey);
        expect(await readArtworkOriginal(db, row.id, store)).toBeNull();
      });
    }));

  test("removes objects with their selection, Item and Library", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const store = testS3Store();
        await expectRemovals(db, root, store, (storageKey) =>
          store.client.exists(storageKey),
        );
      });
    }));
});
