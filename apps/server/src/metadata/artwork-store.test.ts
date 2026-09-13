import { describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { readArtworkOriginal, storeArtworkOriginal } from "./artwork-store.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP4y8CAFWEXHbQSAPZwP0G2GkFNAAAAAElFTkSuQmCC",
  "base64",
);

const poster = {
  type: "poster",
  url: "https://image.example/poster.jpg",
} as const;

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
        const replacement = await sharp({
          create: {
            width: 4,
            height: 4,
            channels: 3,
            background: { r: 255, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer();
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
        const meta = await sharp(truncated).metadata();
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
          storeArtworkOriginal(
            db,
            item.id,
            poster,
            request,
            30_000,
            png.length,
          ),
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
          storeArtworkOriginal(db, item.id, poster, request, 30_000, 4),
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
            storeArtworkOriginal(
              db,
              item.id,
              poster,
              request,
              30_000,
              maxDownloadBytes,
            ),
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
        expect(names).toContain(basename);
      });
    }));

  test("a non-colocated selected row yields a fresh id and is unselected", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) => {
        const { item } = await fixture(db, root);
        const [old] = await db
          .insert(artwork)
          .values({
            itemId: item.id,
            versionId: null,
            type: "poster",
            sourceUrl: "https://image.example/old.jpg",
            backend: "configured-path",
            storageKey: "elsewhere/old.jpg",
            selected: true,
          })
          .returning();
        if (!old) throw new Error("Fixture artwork missing.");
        const { request } = mockRequest(() => new Response(png));
        const row = await storeArtworkOriginal(db, item.id, poster, request);
        expect(row.id).not.toBe(old.id);
        expect(row.backend).toBe("colocated");
        const rows = await db.select().from(artwork).orderBy(artwork.id);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ id: old.id, selected: false });
        expect(rows[1]).toMatchObject({ id: row.id, selected: true });
        expect(await readFile(join(root, row.storageKey))).toEqual(png);
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
          await mkdir(join(root, item.canonicalFolder));
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
          storeArtworkOriginal(db, item.id, poster, request, 1),
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
            storeArtworkOriginal(db, item.id, poster, request, timeoutMs),
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

  test("returns null for a non-colocated artwork row", () =>
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

  test("rejects a .pendia symlink in read mode", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withTempRoot(async (root) =>
        withTempRoot(async (outside) => {
          const { item } = await fixture(db, root);
          await mkdir(join(root, item.canonicalFolder));
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
