import { describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { storeArtworkOriginal } from "./artwork-store.ts";

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
        expect(row).toMatchObject({
          itemId: item.id,
          versionId: null,
          type: "poster",
          sourceUrl: poster.url,
          backend: "colocated",
          storageKey: `Alien (1979)/.pendia/artwork/${row.id}`,
          width: null,
          height: null,
          selected: true,
        });
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
        const replacement = Buffer.from([1, 2, 3, 4]);
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
        expect(second.storageKey).toBe(first.storageKey);
        expect(second.sourceUrl).toBe("https://image.example/new.jpg");
        expect(calls).toHaveLength(2);
        expect(await db.select().from(artwork)).toHaveLength(1);
        expect(await readFile(join(root, first.storageKey))).toEqual(
          replacement,
        );
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
