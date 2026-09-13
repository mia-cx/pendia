import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  episodes,
  files,
  itemAncestors,
  items,
  libraries,
  movies,
  seasons,
  shows,
  streams,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { scanDirectory, scanShowDirectory } from "./scan.ts";

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
});

const showFolder = "The Expanse (2015) {tvdb-280619}";
const specialsFile = `${showFolder}/Specials/The Expanse S00E01.mkv`;
const splitPart1 = `${showFolder}/Season 01/The Expanse S01E01 - part1.mkv`;
const splitPart2 = `${showFolder}/Season 01/The Expanse S01E01 - part2.mkv`;
const rangeFile = `${showFolder}/Season 01/The Expanse S01E02-E03.mkv`;

async function populateShow(root: string) {
  const specialsDir = join(root, showFolder, "Specials");
  const seasonDir = join(root, showFolder, "Season 01");
  await mkdir(specialsDir, { recursive: true });
  await mkdir(join(seasonDir, "extras"), { recursive: true });
  await createVideoFixture(join(root, specialsFile));
  await createVideoFixture(join(root, splitPart1));
  await createVideoFixture(join(root, splitPart2));
  await createVideoFixture(join(root, rangeFile));
  await createVideoFixture(join(seasonDir, "extras", "making-of S01E09.mkv"));
}

describe.skipIf(!databaseUrl)("scanShowDirectory", () => {
  test("writes a Show tree with split and ranged Episode Versions", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await populateShow(root);
        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const result = await scanShowDirectory(db, library.id, showFolder);
        expect(result.probed).toBe(4);
        expect(result.versionIds).toHaveLength(3);
        expect(result.itemId).not.toBeNull();

        const itemRows = await db.select().from(items);
        expect(itemRows).toHaveLength(6);
        const show = itemRows.find((item) => item.kind === "show");
        const seasonItems = itemRows.filter((item) => item.kind === "season");
        const episodeItems = itemRows.filter((item) => item.kind === "episode");
        expect(seasonItems).toHaveLength(2);
        expect(episodeItems).toHaveLength(3);
        expect(show).toMatchObject({
          id: result.itemId,
          libraryId: library.id,
          kind: "show",
          parentId: null,
          title: "The Expanse",
          year: 2015,
          canonicalFolder: showFolder,
        });
        const specials = seasonItems.find(
          (item) => item.canonicalFolder === `${showFolder}/Specials`,
        );
        const seasonOne = seasonItems.find(
          (item) => item.canonicalFolder === `${showFolder}/Season 01`,
        );
        expect(specials?.parentId).toBe(show?.id);
        expect(seasonOne?.parentId).toBe(show?.id);
        const pilot = episodeItems.find(
          (item) => item.parentId === specials?.id,
        );
        const split = episodeItems.find(
          (item) =>
            item.parentId === seasonOne?.id && item.title === "Episode 1",
        );
        const ranged = episodeItems.find(
          (item) =>
            item.parentId === seasonOne?.id && item.title === "Episodes 2-3",
        );
        if (!show || !specials || !seasonOne || !pilot || !split || !ranged) {
          throw new Error("Fixture Item missing.");
        }

        expect(await db.select().from(shows)).toMatchObject([
          { itemId: show.id },
        ]);
        const seasonRows = await db.select().from(seasons);
        expect(seasonRows).toHaveLength(2);
        expect(
          seasonRows.find((row) => row.itemId === specials.id),
        ).toMatchObject({
          showId: show.id,
          seasonNumber: 0,
        });
        expect(
          seasonRows.find((row) => row.itemId === seasonOne.id),
        ).toMatchObject({
          showId: show.id,
          seasonNumber: 1,
        });
        const episodeRows = await db.select().from(episodes);
        expect(episodeRows).toHaveLength(3);
        expect(
          episodeRows.find((row) => row.itemId === pilot.id),
        ).toMatchObject({
          seasonId: specials.id,
          episodeNumber: 1,
          episodeEndNumber: null,
        });
        expect(
          episodeRows.find((row) => row.itemId === split.id),
        ).toMatchObject({
          seasonId: seasonOne.id,
          episodeNumber: 1,
          episodeEndNumber: null,
        });
        expect(
          episodeRows.find((row) => row.itemId === ranged.id),
        ).toMatchObject({
          seasonId: seasonOne.id,
          episodeNumber: 2,
          episodeEndNumber: 3,
        });

        const closure = await db.select().from(itemAncestors);
        const pairs = closure
          .map((row) => `${row.ancestorId}->${row.descendantId}:${row.depth}`)
          .sort();
        const expectedPairs = [show, specials, seasonOne, pilot, split, ranged]
          .map((item) => `${item.id}->${item.id}:0`)
          .concat([
            `${show.id}->${specials.id}:1`,
            `${show.id}->${seasonOne.id}:1`,
            `${show.id}->${pilot.id}:2`,
            `${show.id}->${split.id}:2`,
            `${show.id}->${ranged.id}:2`,
            `${specials.id}->${pilot.id}:1`,
            `${seasonOne.id}->${split.id}:1`,
            `${seasonOne.id}->${ranged.id}:1`,
          ])
          .sort();
        expect(pairs).toEqual(expectedPairs);

        const versionRows = await db.select().from(versions);
        expect(versionRows).toHaveLength(3);
        const episodeIds = [pilot.id, split.id, ranged.id];
        for (const version of versionRows) {
          expect(version).toMatchObject({
            itemKind: "episode",
            libraryId: library.id,
            format: "video",
            origin: "imported",
          });
          expect(episodeIds).toContain(version.itemId);
        }

        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(4);
        const byPath = new Map(fileRows.map((file) => [file.path, file]));
        const part1 = byPath.get(splitPart1);
        const part2 = byPath.get(splitPart2);
        const range = byPath.get(rangeFile);
        const special = byPath.get(specialsFile);
        if (!part1 || !part2 || !range || !special) {
          throw new Error("Fixture File missing.");
        }
        expect(part1.versionId).toBe(part2.versionId);
        expect(part1.order).toBe(0);
        expect(part2.order).toBe(1);
        expect(part1.itemId).toBe(split.id);
        expect(part2.itemId).toBe(split.id);
        expect(range.versionId).not.toBe(part1.versionId);
        expect(range.itemId).toBe(ranged.id);
        expect(range.order).toBe(0);
        expect(special.versionId).not.toBe(part1.versionId);
        expect(special.versionId).not.toBe(range.versionId);
        expect(special.itemId).toBe(pilot.id);
        expect(result.versionIds).toEqual([
          special.versionId,
          part1.versionId,
          range.versionId,
        ]);
        expect(
          byPath.get(`${showFolder}/Season 01/extras/making-of S01E09.mkv`),
        ).toBeUndefined();

        const streamRows = await db
          .select()
          .from(streams)
          .orderBy(asc(streams.fileId), asc(streams.index));
        expect(streamRows).toHaveLength(12);
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
        }

        const splitVersion = versionRows.find(
          (version) => version.id === part1.versionId,
        );
        expect(splitVersion?.bytes).toBe(part1.bytes + part2.bytes);
        expect(splitVersion?.durationSeconds).toBe(
          (part1.durationSeconds ?? 0) + (part2.durationSeconds ?? 0),
        );

        const snapshotIds = async () => ({
          items: (await db.select({ id: items.id }).from(items))
            .map((row) => row.id)
            .sort(),
          shows: (await db.select({ id: shows.itemId }).from(shows))
            .map((row) => row.id)
            .sort(),
          seasons: (await db.select({ id: seasons.itemId }).from(seasons))
            .map((row) => row.id)
            .sort(),
          episodes: (await db.select({ id: episodes.itemId }).from(episodes))
            .map((row) => row.id)
            .sort(),
          versions: (await db.select({ id: versions.id }).from(versions))
            .map((row) => row.id)
            .sort(),
          files: (await db.select({ id: files.id }).from(files))
            .map((row) => row.id)
            .sort(),
          streams: (await db.select({ id: streams.id }).from(streams))
            .map((row) => row.id)
            .sort(),
        });
        const before = await snapshotIds();
        for (const [itemId, title] of [
          [show.id, "Curated Expanse"],
          [seasonOne.id, "Curated Season"],
          [split.id, "Curated Episode"],
        ] as const) {
          await db.update(items).set({ title }).where(eq(items.id, itemId));
        }

        const seen: string[] = [];
        const second = await scanShowDirectory(
          db,
          library.id,
          showFolder,
          async (path) => {
            seen.push(path);
            return probeVideo(path);
          },
        );
        expect(second.itemId).toBe(result.itemId);
        expect(second.versionIds).toEqual(result.versionIds);
        expect(second.probed).toBe(0);
        expect(seen).toHaveLength(0);
        expect(await snapshotIds()).toEqual(before);
        const curated = await db.select().from(items);
        expect(curated.find((item) => item.id === show.id)?.title).toBe(
          "Curated Expanse",
        );
        expect(curated.find((item) => item.id === seasonOne.id)?.title).toBe(
          "Curated Season",
        );
        expect(curated.find((item) => item.id === split.id)?.title).toBe(
          "Curated Episode",
        );
      });
    }));

  test("reorders existing split Files when earlier and middle parts arrive", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Show";
        const seasonDir = join(root, show, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const source = join(seasonDir, "Show S01E02 - part1.mkv");
        await createVideoFixture(source);
        await copyFile(source, join(seasonDir, "Show S01E01 - part2.mkv"));
        await copyFile(source, join(seasonDir, "Show S01E02 - part3.mkv"));

        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const showPath = (name: string) => `${show}/Season 01/${name}`;
        const ep1Part1 = showPath("Show S01E01 - part1.mkv");
        const ep1Part2 = showPath("Show S01E01 - part2.mkv");
        const ep2Part1 = showPath("Show S01E02 - part1.mkv");
        const ep2Part2 = showPath("Show S01E02 - part2.mkv");
        const ep2Part3 = showPath("Show S01E02 - part3.mkv");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(2);
        const initialFiles = await db.select().from(files);
        expect(initialFiles).toHaveLength(3);
        const idsByPath = new Map(
          initialFiles.map((file) => [file.path, file.id]),
        );

        await copyFile(source, join(seasonDir, "Show S01E01 - part1.mkv"));
        await copyFile(source, join(seasonDir, "Show S01E02 - part2.mkv"));

        const second = await scanShowDirectory(db, library.id, show);
        expect(second.versionIds).toEqual(first.versionIds);
        expect(await db.select().from(versions)).toHaveLength(2);

        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(5);
        const byPath = new Map(fileRows.map((file) => [file.path, file]));
        const p11 = byPath.get(ep1Part1);
        const p12 = byPath.get(ep1Part2);
        const p21 = byPath.get(ep2Part1);
        const p22 = byPath.get(ep2Part2);
        const p23 = byPath.get(ep2Part3);
        if (!p11 || !p12 || !p21 || !p22 || !p23) {
          throw new Error("Fixture File missing.");
        }
        expect(p11.versionId).toBe(p12.versionId);
        expect([p11.order, p12.order]).toEqual([0, 1]);
        expect(p21.versionId).toBe(p22.versionId);
        expect(p22.versionId).toBe(p23.versionId);
        expect([p21.order, p22.order, p23.order]).toEqual([0, 1, 2]);
        for (const path of [ep1Part2, ep2Part1, ep2Part3]) {
          expect(byPath.get(path)?.id).toBe(idsByPath.get(path));
        }
      });
    }));

  test("keeps stale File orders bounded across repeated scans", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Show";
        const seasonDir = join(root, show, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const part1 = join(seasonDir, "Show S01E01 - part1.mkv");
        const part2 = join(seasonDir, "Show S01E01 - part2.mkv");
        await createVideoFixture(part1);
        await copyFile(part1, part2);

        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(1);
        const initialFiles = await db.select().from(files);
        expect(initialFiles).toHaveLength(2);
        const idsByPath = new Map(
          initialFiles.map((file) => [file.path, file.id]),
        );

        await rename(part1, join(seasonDir, "Show S01E01 - part1.removed"));

        for (let index = 0; index < 32; index++) {
          await scanShowDirectory(db, library.id, show);
        }

        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(2);
        const part1Path = "Show/Season 01/Show S01E01 - part1.mkv";
        const part2Path = "Show/Season 01/Show S01E01 - part2.mkv";
        const byPath = new Map(fileRows.map((file) => [file.path, file]));
        const kept = byPath.get(part2Path);
        const stale = byPath.get(part1Path);
        if (!kept || !stale) throw new Error("Fixture File missing.");
        expect(kept.order).toBe(0);
        expect(stale.order).toBe(1);
        expect(idsByPath.get(part2Path)).toBe(kept.id);
        expect(idsByPath.get(part1Path)).toBe(stale.id);
        expect(Math.max(...fileRows.map((file) => file.order))).toBe(1);
      });
    }));
});
