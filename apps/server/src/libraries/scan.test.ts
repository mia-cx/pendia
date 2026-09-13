import { describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MetadataProvider } from "@pendia/plugin-api";
import { asc, eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  itemAncestors,
  items,
  libraries,
  movies,
  providerIds,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { applyMetadata } from "../metadata/service.ts";
import { scanDirectory } from "./scan.ts";

const folder = "Alien (1979) {tmdb-348}";
const file1080 = `${folder}/Alien.1080p.mkv`;
const file2160 = `${folder}/Alien.2160p {edition-Director's Cut}.mkv`;

async function populate(root: string) {
  const dir = join(root, folder);
  await mkdir(join(dir, "extras"), { recursive: true });
  await createVideoFixture(join(dir, "Alien.1080p.mkv"), {
    width: 3840,
    height: 2160,
  });
  await createVideoFixture(
    join(dir, "Alien.2160p {edition-Director's Cut}.mkv"),
    { width: 1920, height: 1080 },
  );
  await createVideoFixture(join(dir, "extras", "making-of.mkv"));
  await mkdir(join(dir, ".pendia"));
  await writeFile(join(dir, ".pendia", "art.mp4"), "tempting");
  await mkdir(join(dir, "Alien.1080p.mkv.pendia", "720p"), {
    recursive: true,
  });
  await writeFile(
    join(dir, "Alien.1080p.mkv.pendia", "720p", "init.mp4"),
    "tempting",
  );
}

async function withLibrary(
  db: Database,
  rootPath: string,
  run: (library: { id: string; rootPath: string }) => Promise<void>,
) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  await run(library);
}

const streamKeys = (rows: { index: number; codec: string; kind: string }[]) =>
  rows.map((row) => `${row.index}:${row.kind}:${row.codec}`);

describe.skipIf(!databaseUrl)("scanDirectory", () => {
  test("writes one Item with two Versions, Files and Streams for a canonical folder", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await populate(root);
        await withLibrary(db, root, async (library) => {
          const result = await scanDirectory(db, library.id, folder);
          expect(result.probed).toBe(2);
          expect(result.versionIds).toHaveLength(2);
          expect(result.itemId).not.toBeNull();

          expect(await db.select().from(items)).toMatchObject([
            {
              id: result.itemId,
              libraryId: library.id,
              kind: "movie",
              title: "Alien",
              year: 1979,
              canonicalFolder: folder,
            },
          ]);
          expect(await db.select().from(movies)).toMatchObject([
            { itemId: result.itemId },
          ]);
          expect(await db.select().from(itemAncestors)).toMatchObject([
            {
              ancestorId: result.itemId,
              descendantId: result.itemId,
              depth: 0,
            },
          ]);
          expect(await db.select().from(providerIds)).toMatchObject([
            { provider: "tmdb", value: "348", itemId: result.itemId },
          ]);

          const versionRows = await db
            .select()
            .from(versions)
            .orderBy(asc(versions.label));
          expect(versionRows.map((version) => version.id)).toEqual(
            result.versionIds,
          );
          expect(versionRows.map((version) => version.label)).toEqual([
            "4K · H.264 · AAC",
            "Director's Cut · 1080p · H.264 · AAC",
          ]);
          for (const version of versionRows) {
            expect(version).toMatchObject({
              itemId: result.itemId,
              itemKind: "movie",
              libraryId: library.id,
              format: "video",
              origin: "imported",
              timelineAligned: true,
            });
            expect(version.segmentTimelineId).not.toBeNull();
          }

          const fileRows = await db
            .select()
            .from(files)
            .orderBy(asc(files.path));
          expect(fileRows.map((file) => file.path)).toEqual([
            file1080,
            file2160,
          ]);
          expect(fileRows.map((file) => file.versionId)).toEqual(
            result.versionIds,
          );
          for (const file of fileRows) {
            expect(file).toMatchObject({
              itemId: result.itemId,
              libraryId: library.id,
              order: 0,
              container: "mkv",
              chapters: [],
            });
          }

          const streamRows = await db
            .select()
            .from(streams)
            .orderBy(asc(streams.fileId), asc(streams.index));
          expect(streamRows).toHaveLength(6);
          for (const file of fileRows) {
            const owned = streamRows.filter(
              (stream) => stream.fileId === file.id,
            );
            const probed = await probeVideo(join(root, file.path));
            expect(streamKeys(owned)).toEqual(
              probed.streams.map(
                (stream) => `${stream.index}:${stream.kind}:${stream.codec}`,
              ),
            );
            expect(owned.map((stream) => stream.codec)).toEqual([
              "h264",
              "aac",
              "subrip",
            ]);
          }
        });
      });
    }));

  test("repeats without probing, preserves identities and keeps curated metadata", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await populate(root);
        await withLibrary(db, root, async (library) => {
          const seen: string[] = [];
          const probe = async (path: string) => {
            seen.push(path);
            return probeVideo(path);
          };
          const first = await scanDirectory(db, library.id, folder, probe);
          expect(seen).toHaveLength(2);
          const fileIds = (await db.select().from(files))
            .map((file) => file.id)
            .sort();
          const streamIds = (await db.select().from(streams))
            .map((stream) => stream.id)
            .sort();

          const [initialId] = await db
            .select()
            .from(providerIds)
            .where(eq(providerIds.itemId, first.itemId ?? ""));
          expect(initialId).toMatchObject({
            provider: "tmdb",
            value: "348",
            itemId: first.itemId,
          });

          const second = await scanDirectory(db, library.id, folder, probe);
          expect(second.itemId).toBe(first.itemId);
          expect(second.versionIds).toEqual(first.versionIds);
          expect(second.probed).toBe(0);
          expect(seen).toHaveLength(2);
          expect(
            (await db.select().from(files)).map((file) => file.id).sort(),
          ).toEqual(fileIds);
          expect(
            (await db.select().from(streams)).map((stream) => stream.id).sort(),
          ).toEqual(streamIds);

          await db
            .update(items)
            .set({
              title: "Curated Alien",
              overview: "Curated overview.",
              tags: ["curated"],
            })
            .where(eq(items.id, first.itemId ?? ""));
          const curated = await scanDirectory(db, library.id, folder, probe);
          expect(curated.itemId).toBe(first.itemId);
          expect(curated.versionIds).toEqual(first.versionIds);
          expect(curated.probed).toBe(0);
          expect(seen).toHaveLength(2);
          expect(await db.select().from(items)).toMatchObject([
            { id: first.itemId, title: "Curated Alien", tags: ["curated"] },
          ]);

          const touched = new Date("2026-02-03T00:00:00Z");
          await utimes(join(root, file1080), touched, touched);
          const third = await scanDirectory(db, library.id, folder, probe);
          expect(third.itemId).toBe(first.itemId);
          expect(third.versionIds).toEqual(first.versionIds);
          expect(third.probed).toBe(1);
          expect(seen).toHaveLength(3);
          expect(
            (await db.select().from(streams)).map((stream) => stream.id).sort(),
          ).toEqual(streamIds);
          expect(
            await db
              .select()
              .from(providerIds)
              .where(eq(providerIds.itemId, first.itemId ?? "")),
          ).toEqual([expect.objectContaining({ id: initialId?.id })]);
        });
      });
    }));

  test("replaces one File's stream inventory and preserves stream ids", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await populate(root);
        await withLibrary(db, root, async (library) => {
          await scanDirectory(db, library.id, folder);
          const [target] = await db
            .select()
            .from(files)
            .where(eq(files.path, file1080));
          if (!target) throw new Error("Fixture File missing.");
          const before = await db
            .select()
            .from(streams)
            .where(eq(streams.fileId, target.id))
            .orderBy(asc(streams.index));
          expect(before).toHaveLength(3);

          const touched = new Date("2026-02-03T00:00:00Z");
          await utimes(join(root, file1080), touched, touched);
          const absolute = join(root, file1080);
          const result = await scanDirectory(
            db,
            library.id,
            folder,
            async (path) => {
              const probed = await probeVideo(path);
              if (path !== absolute) return probed;
              return {
                ...probed,
                streams: probed.streams.filter(
                  (stream) => stream.kind !== "subtitle",
                ),
              };
            },
          );
          expect(result.probed).toBe(1);

          const after = await db
            .select()
            .from(streams)
            .where(eq(streams.fileId, target.id))
            .orderBy(asc(streams.index));
          expect(after.map((stream) => stream.index)).toEqual([0, 1]);
          expect(after.map((stream) => stream.id)).toEqual(
            before.slice(0, 2).map((stream) => stream.id),
          );
        });
      });
    }));

  test("aborts the directory write when a member has no video stream", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await populate(root);
        await withLibrary(db, root, async (library) => {
          const absolute = join(root, file2160);
          await expect(
            scanDirectory(db, library.id, folder, async (path) => {
              const probed = await probeVideo(path);
              if (path !== absolute) return probed;
              return {
                ...probed,
                streams: probed.streams.filter(
                  (stream) => stream.kind !== "video",
                ),
              };
            }),
          ).rejects.toThrow("no video stream");
          expect(await db.select().from(items)).toHaveLength(0);
          expect(await db.select().from(versions)).toHaveLength(0);
          expect(await db.select().from(files)).toHaveLength(0);
        });
      });
    }));

  test("two simultaneous scans write one Item, two Versions and six Streams", () =>
    withDatabase(async (_db, url) => {
      const db = createDatabase(url);
      try {
        await migrateDatabase(db.db);
        await withVideoFixture(async (root) => {
          await populate(root);
          await withLibrary(db.db, root, async (library) => {
            const first = createDatabase(url);
            const second = createDatabase(url);
            try {
              const results = await Promise.all([
                scanDirectory(first.db, library.id, folder),
                scanDirectory(second.db, library.id, folder),
              ]);
              expect(results[0]?.itemId).toBe(results[1]?.itemId);
              expect(results[0]?.versionIds).toEqual(results[1]?.versionIds);
              expect(await db.db.select().from(items)).toHaveLength(1);
              expect(await db.db.select().from(versions)).toHaveLength(2);
              expect(await db.db.select().from(files)).toHaveLength(2);
              expect(await db.db.select().from(streams)).toHaveLength(6);
            } finally {
              await first.close();
              await second.close();
            }
          });
        });
      } finally {
        await db.close();
      }
    }));

  test("a malformed folder provider id stores nothing and falls back to search", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const badFolder = "Bad Movie (2020) {tmdb-abc}";
        await mkdir(join(root, badFolder));
        await createVideoFixture(join(root, badFolder, "Bad Movie.mkv"));
        await withLibrary(db, root, async (library) => {
          const result = await scanDirectory(db, library.id, badFolder);
          expect(result.itemId).not.toBeNull();
          expect(await db.select().from(providerIds)).toHaveLength(0);
          const searches: Parameters<MetadataProvider["search"]>[0][] = [];
          const provider: MetadataProvider = {
            id: "tmdb",
            kinds: ["movie"],
            search: async (query) => {
              searches.push(query);
              return [];
            },
            fetch: async () => {
              throw new Error("Unexpected fetch.");
            },
          };
          const application = await applyMetadata(db, result.itemId ?? "", [
            provider,
          ]);
          expect(application.state).toBe("unmatched");
          expect(searches).toEqual([
            { title: "Bad Movie", year: 2020, kind: "movie" },
          ]);
        });
      });
    }));
});
