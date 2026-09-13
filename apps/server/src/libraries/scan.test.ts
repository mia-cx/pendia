import { describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  episodes,
  files,
  itemAncestors,
  items,
  libraries,
  movies,
  progress,
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

async function holdLibraryLock(
  url: string,
  libraryId: string,
  run: (release: () => void) => Promise<void>,
) {
  const second = createDatabase(url);
  let release = () => {};
  let lockHeld = false;
  try {
    const locking = second.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from libraries where id = ${libraryId} for update`,
      );
      lockHeld = true;
      await new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
    });
    const deadline = Date.now() + 2_000;
    while (!lockHeld && Date.now() < deadline) await Bun.sleep(10);
    if (!lockHeld) throw new Error("Library row lock was not acquired.");
    await run(release);
    await locking;
  } finally {
    release();
    await second.close();
  }
}

async function waitForBlockedScan(db: Database) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await db.$client<{ count: number }[]>`
      select count(*)::integer as count from pg_stat_activity
      where wait_event_type = 'Lock'`;
    if ((rows[0]?.count ?? 0) > 0) return;
    if (Date.now() >= deadline) {
      throw new Error("A blocked scan update was not observed.");
    }
    await Bun.sleep(10);
  }
}

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
          const first = await scanDirectory(db, library.id, folder, { probe });
          expect(seen).toHaveLength(2);
          const fileIds = (await db.select().from(files))
            .map((file) => file.id)
            .sort();
          const streamIds = (await db.select().from(streams))
            .map((stream) => stream.id)
            .sort();

          const second = await scanDirectory(db, library.id, folder, {
            probe,
          });
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
          const curated = await scanDirectory(db, library.id, folder, {
            probe,
          });
          expect(curated.itemId).toBe(first.itemId);
          expect(curated.versionIds).toEqual(first.versionIds);
          expect(curated.probed).toBe(0);
          expect(seen).toHaveLength(2);
          expect(await db.select().from(items)).toMatchObject([
            { id: first.itemId, title: "Curated Alien", tags: ["curated"] },
          ]);

          const touched = new Date("2026-02-03T00:00:00Z");
          await utimes(join(root, file1080), touched, touched);
          const third = await scanDirectory(db, library.id, folder, { probe });
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
          const result = await scanDirectory(db, library.id, folder, {
            probe: async (path) => {
              const probed = await probeVideo(path);
              if (path !== absolute) return probed;
              return {
                ...probed,
                streams: probed.streams.filter(
                  (stream) => stream.kind !== "subtitle",
                ),
              };
            },
          });
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
            scanDirectory(db, library.id, folder, {
              probe: async (path) => {
                const probed = await probeVideo(path);
                if (path !== absolute) return probed;
                return {
                  ...probed,
                  streams: probed.streams.filter(
                    (stream) => stream.kind !== "video",
                  ),
                };
              },
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

  test("an emptied movie folder revalidates before deleting the Item", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createVideoFixture(join(dir, "Alien.1080p.mkv"));
        await withLibrary(db, root, async (library) => {
          const scanned = await scanDirectory(db, library.id, folder);
          const itemId = scanned.itemId;
          if (!itemId) throw new Error("Initial scan produced no Item.");
          const [version] = await db.select().from(versions);
          if (!version) throw new Error("Initial scan produced no Version.");
          const admin = await setupAdmin(db, {
            username: "admin",
            password: "admin-pass",
          });
          await db.insert(progress).values({
            userId: admin.id,
            itemId,
            versionId: version.id,
            format: "video",
            positionSeconds: 33,
          });
          const progressBefore = await db.select().from(progress);
          await rm(join(dir, "Alien.1080p.mkv"));

          await holdLibraryLock(url, library.id, async (release) => {
            const scanning = scanDirectory(db, library.id, folder, {
              reconcileMissing: true,
            });
            await waitForBlockedScan(db);
            await createVideoFixture(join(dir, "Alien.720p.mkv"));
            release();
            await expect(scanning).rejects.toThrow(
              "Library directory changed before scan write.",
            );
          });

          const itemRows = await db.select().from(items);
          expect(itemRows.map((row) => row.id)).toEqual([itemId]);
          expect(await db.select().from(versions)).toHaveLength(1);
          expect(await db.select().from(files)).toHaveLength(1);
          expect(await db.select().from(progress)).toEqual(progressBefore);
        });
      });
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
        const second = await scanShowDirectory(db, library.id, showFolder, {
          probe: async (path) => {
            seen.push(path);
            return probeVideo(path);
          },
        });
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

  test("keeps equivalent season folder splits as distinct Versions", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Show";
        const season1Dir = join(root, show, "Season 1");
        await mkdir(season1Dir, { recursive: true });
        const part1 = join(season1Dir, "Show S01E01 - part1.mkv");
        await createVideoFixture(part1);

        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(1);
        const firstFiles = await db.select().from(files);
        expect(firstFiles).toHaveLength(1);
        const firstFileIds = firstFiles.map((file) => file.id);

        const season01Dir = join(root, show, "Season 01");
        await mkdir(season01Dir, { recursive: true });
        await copyFile(part1, join(season01Dir, "Show S01E01 - part2.mkv"));

        const second = await scanShowDirectory(db, library.id, show);
        expect(second.versionIds).toHaveLength(2);

        const itemRows = await db.select().from(items);
        expect(itemRows.filter((item) => item.kind === "show")).toHaveLength(1);
        expect(itemRows.filter((item) => item.kind === "season")).toHaveLength(
          1,
        );
        expect(itemRows.filter((item) => item.kind === "episode")).toHaveLength(
          1,
        );
        expect(await db.select().from(seasons)).toMatchObject([
          { seasonNumber: 1 },
        ]);
        expect(await db.select().from(episodes)).toMatchObject([
          { episodeNumber: 1 },
        ]);

        const versionRows = await db.select().from(versions);
        expect(versionRows).toHaveLength(2);
        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(2);
        for (const file of fileRows) {
          expect(file.order).toBe(0);
        }
        expect(new Set(fileRows.map((file) => file.versionId))).toHaveLength(2);
        expect(fileRows.map((file) => file.id)).toEqual(
          expect.arrayContaining(firstFileIds),
        );
        expect(versionRows.map((version) => version.id)).toEqual(
          expect.arrayContaining(first.versionIds),
        );

        const third = await scanShowDirectory(db, library.id, show);
        expect(third.versionIds).toEqual(second.versionIds);
        const stableFiles = await db.select().from(files);
        expect(stableFiles).toHaveLength(2);
        expect(stableFiles.map((file) => file.id).sort()).toEqual(
          fileRows.map((file) => file.id).sort(),
        );
        expect(
          (await db.select().from(versions))
            .map((version) => version.id)
            .sort(),
        ).toEqual(versionRows.map((version) => version.id).sort());
      });
    }));

  test("preserves a retained range when its ranged path disappears", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Show";
        const seasonDir = join(root, show, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const ranged = join(seasonDir, "Show S01E01-E02.mkv");
        const single = join(seasonDir, "Show S01E01.mkv");
        await createVideoFixture(ranged);
        await copyFile(ranged, single);

        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(2);
        const episodeRows = await db.select().from(episodes);
        expect(episodeRows).toMatchObject([
          { episodeNumber: 1, episodeEndNumber: 2 },
        ]);
        const firstEpisodeId = episodeRows[0]?.itemId;
        if (!firstEpisodeId) throw new Error("Fixture Episode missing.");
        const firstFileIds = (await db.select().from(files))
          .map((file) => file.id)
          .sort();
        expect(firstFileIds).toHaveLength(2);

        await rename(ranged, join(seasonDir, "Show S01E01-E02.removed"));

        const second = await scanShowDirectory(db, library.id, show);
        expect(second.versionIds).toHaveLength(1);
        expect(await db.select().from(episodes)).toMatchObject([
          { episodeNumber: 1, episodeEndNumber: 2 },
        ]);
        expect(await db.select().from(versions)).toHaveLength(2);
        const secondFiles = await db.select().from(files);
        expect(secondFiles).toHaveLength(2);
        expect(secondFiles.map((file) => file.id).sort()).toEqual(firstFileIds);
        const surviving = secondFiles.find(
          (file) => file.path === "Show/Season 01/Show S01E01.mkv",
        );
        if (!surviving) throw new Error("Fixture File missing.");
        expect(second.versionIds).toEqual([surviving.versionId]);

        await copyFile(single, join(seasonDir, "Show S01E02.mkv"));

        const third = await scanShowDirectory(db, library.id, show);
        const thirdFiles = await db.select().from(files);
        expect(thirdFiles).toHaveLength(3);
        const added = thirdFiles.find(
          (file) => file.path === "Show/Season 01/Show S01E02.mkv",
        );
        if (!added) throw new Error("Fixture File missing.");
        expect(third.versionIds).toEqual([
          surviving.versionId,
          added.versionId,
        ]);

        const thirdEpisodes = await db
          .select()
          .from(episodes)
          .orderBy(asc(episodes.episodeNumber));
        expect(thirdEpisodes).toMatchObject([
          {
            itemId: firstEpisodeId,
            episodeNumber: 1,
            episodeEndNumber: null,
          },
          { episodeNumber: 2, episodeEndNumber: null },
        ]);
        const addedEpisodeId = thirdEpisodes[1]?.itemId;
        if (!addedEpisodeId) throw new Error("Fixture Episode missing.");
        expect(added.itemId).toBe(addedEpisodeId);
        const thirdVersions = await db.select().from(versions);
        expect(thirdVersions).toHaveLength(3);
        expect(thirdVersions.map((version) => version.id).sort()).toEqual(
          expect.arrayContaining(first.versionIds),
        );
        expect(thirdFiles.map((file) => file.id).sort()).toEqual(
          expect.arrayContaining(firstFileIds),
        );
        const addedVersion = thirdVersions.find(
          (version) => version.id === added.versionId,
        );
        expect(addedVersion?.itemId).toBe(addedEpisodeId);

        const fourth = await scanShowDirectory(db, library.id, show);
        expect(fourth.versionIds).toEqual(third.versionIds);
        expect(
          await db.select().from(episodes).orderBy(asc(episodes.episodeNumber)),
        ).toMatchObject([
          {
            itemId: firstEpisodeId,
            episodeNumber: 1,
            episodeEndNumber: null,
          },
          {
            itemId: addedEpisodeId,
            episodeNumber: 2,
            episodeEndNumber: null,
          },
        ]);
        expect(
          (await db.select().from(files)).map((file) => file.id).sort(),
        ).toEqual(thirdFiles.map((file) => file.id).sort());
        expect(
          (await db.select().from(versions))
            .map((version) => version.id)
            .sort(),
        ).toEqual(thirdVersions.map((version) => version.id).sort());
      });
    }));

  test("does not widen into a retained standalone Episode", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Show";
        const seasonDir = join(root, show, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const firstPath = join(seasonDir, "Show S01E01.mkv");
        const secondPath = join(seasonDir, "Show S01E02.mkv");
        await createVideoFixture(firstPath);
        await copyFile(firstPath, secondPath);

        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(2);
        const firstEpisodes = await db
          .select()
          .from(episodes)
          .orderBy(asc(episodes.episodeNumber));
        expect(firstEpisodes).toMatchObject([
          { episodeNumber: 1, episodeEndNumber: null },
          { episodeNumber: 2, episodeEndNumber: null },
        ]);
        const firstEpisodeIds = firstEpisodes.map((row) => row.itemId);
        const firstFileIds = (await db.select().from(files))
          .map((file) => file.id)
          .sort();
        expect(firstFileIds).toHaveLength(2);

        await copyFile(firstPath, join(seasonDir, "Show S01E01-E02.mkv"));
        await rename(firstPath, join(seasonDir, "Show S01E01.removed"));
        await rename(secondPath, join(seasonDir, "Show S01E02.removed"));

        const second = await scanShowDirectory(db, library.id, show);
        expect(second.versionIds).toHaveLength(1);
        const secondEpisodes = await db
          .select()
          .from(episodes)
          .orderBy(asc(episodes.episodeNumber));
        expect(secondEpisodes).toMatchObject([
          {
            itemId: firstEpisodeIds[0],
            episodeNumber: 1,
            episodeEndNumber: null,
          },
          {
            itemId: firstEpisodeIds[1],
            episodeNumber: 2,
            episodeEndNumber: null,
          },
        ]);
        const versionRows = await db.select().from(versions);
        expect(versionRows).toHaveLength(3);
        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(3);
        const rangedFile = fileRows.find(
          (file) => file.path === "Show/Season 01/Show S01E01-E02.mkv",
        );
        if (!rangedFile || !firstEpisodeIds[0]) {
          throw new Error("Fixture File missing.");
        }
        expect(rangedFile.itemId).toBe(firstEpisodeIds[0]);
        expect(second.versionIds).toEqual([rangedFile.versionId]);
        expect(
          versionRows.find((version) => version.id === rangedFile.versionId)
            ?.itemId,
        ).toBe(firstEpisodeIds[0]);
        expect(fileRows.map((file) => file.id).sort()).toEqual(
          expect.arrayContaining(firstFileIds),
        );
        expect(versionRows.map((version) => version.id).sort()).toEqual(
          expect.arrayContaining(first.versionIds),
        );

        const third = await scanShowDirectory(db, library.id, show);
        expect(third.versionIds).toEqual(second.versionIds);
        expect(
          await db.select().from(episodes).orderBy(asc(episodes.episodeNumber)),
        ).toMatchObject([
          { episodeNumber: 1, episodeEndNumber: null },
          { episodeNumber: 2, episodeEndNumber: null },
        ]);
        expect(
          (await db.select().from(files)).map((file) => file.id).sort(),
        ).toEqual(fileRows.map((file) => file.id).sort());
        expect(
          (await db.select().from(versions))
            .map((version) => version.id)
            .sort(),
        ).toEqual(versionRows.map((version) => version.id).sort());
      });
    }));

  test("releases a retained range before inserting its replacement Episode", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Show";
        const seasonDir = join(root, show, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const rangedPath = join(seasonDir, "Show S01E01-E02.mkv");
        await createVideoFixture(rangedPath);

        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(1);
        const firstEpisodes = await db
          .select()
          .from(episodes)
          .orderBy(asc(episodes.episodeNumber));
        expect(firstEpisodes).toMatchObject([
          { episodeNumber: 1, episodeEndNumber: 2 },
        ]);
        const rangedEpisodeId = firstEpisodes[0]?.itemId;
        if (!rangedEpisodeId) throw new Error("Fixture Episode missing.");
        const firstFileIds = (await db.select().from(files))
          .map((file) => file.id)
          .sort();
        expect(firstFileIds).toHaveLength(1);

        await copyFile(rangedPath, join(seasonDir, "Show S01E02.mkv"));
        await rename(rangedPath, join(seasonDir, "Show S01E01-E02.removed"));

        const second = await scanShowDirectory(db, library.id, show);
        expect(second.versionIds).toHaveLength(1);
        const secondEpisodes = await db
          .select()
          .from(episodes)
          .orderBy(asc(episodes.episodeNumber));
        expect(secondEpisodes).toMatchObject([
          {
            itemId: rangedEpisodeId,
            episodeNumber: 1,
            episodeEndNumber: null,
          },
          { episodeNumber: 2, episodeEndNumber: null },
        ]);
        const versionRows = await db.select().from(versions);
        expect(versionRows).toHaveLength(2);
        const fileRows = await db.select().from(files);
        expect(fileRows).toHaveLength(2);
        const standaloneFile = fileRows.find(
          (file) => file.path === "Show/Season 01/Show S01E02.mkv",
        );
        const secondEpisode = secondEpisodes[1];
        if (!standaloneFile || !secondEpisode) {
          throw new Error("Fixture File missing.");
        }
        expect(standaloneFile.itemId).toBe(secondEpisode.itemId);
        expect(second.versionIds).toEqual([standaloneFile.versionId]);
        expect(
          versionRows.find((version) => version.id === standaloneFile.versionId)
            ?.itemId,
        ).toBe(secondEpisode.itemId);
        expect(fileRows.map((file) => file.id).sort()).toEqual(
          expect.arrayContaining(firstFileIds),
        );
        expect(versionRows.map((version) => version.id).sort()).toEqual(
          expect.arrayContaining(first.versionIds),
        );

        const third = await scanShowDirectory(db, library.id, show);
        expect(third.versionIds).toEqual(second.versionIds);
        expect(
          await db.select().from(episodes).orderBy(asc(episodes.episodeNumber)),
        ).toMatchObject([
          { episodeNumber: 1, episodeEndNumber: null },
          { episodeNumber: 2, episodeEndNumber: null },
        ]);
        expect(
          (await db.select().from(files)).map((file) => file.id).sort(),
        ).toEqual(fileRows.map((file) => file.id).sort());
        expect(
          (await db.select().from(versions))
            .map((version) => version.id)
            .sort(),
        ).toEqual(versionRows.map((version) => version.id).sort());
      });
    }));

  test("reconcileMissing removes a missing Season while the default retains it", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Foundation";
        const seasonOneDir = join(root, show, "Season 01");
        const seasonTwoDir = join(root, show, "Season 02");
        await mkdir(seasonOneDir, { recursive: true });
        await mkdir(seasonTwoDir, { recursive: true });
        await createVideoFixture(join(seasonOneDir, "Foundation S01E01.mkv"));
        await createVideoFixture(join(seasonTwoDir, "Foundation S02E01.mkv"));
        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(2);
        expect(await db.select().from(items)).toHaveLength(5);
        expect(await db.select().from(seasons)).toHaveLength(2);

        await rm(seasonTwoDir, { recursive: true });

        const second = await scanShowDirectory(db, library.id, show);
        expect(second.versionIds).toHaveLength(1);
        expect(await db.select().from(items)).toHaveLength(5);
        expect(await db.select().from(seasons)).toHaveLength(2);
        expect(await db.select().from(versions)).toHaveLength(2);
        expect(await db.select().from(files)).toHaveLength(2);

        const third = await scanShowDirectory(db, library.id, show, {
          reconcileMissing: true,
        });
        expect(third.versionIds).toHaveLength(1);
        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.kind).sort()).toEqual([
          "episode",
          "season",
          "show",
        ]);
        expect(
          itemRows.find((row) => row.kind === "show")?.canonicalFolder,
        ).toBe(show);
        const seasonRows = await db.select().from(seasons);
        expect(seasonRows).toHaveLength(1);
        expect(seasonRows[0]?.seasonNumber).toBe(1);
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toHaveLength(1);
      });
    }));

  test("reconcileMissing removes only the missing File of a split Version", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Show";
        const seasonDir = join(root, show, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        const part1 = join(seasonDir, "Show S01E01 - part1.mkv");
        const part2 = join(seasonDir, "Show S01E01 - part2.mkv");
        await createVideoFixture(part1);
        await createVideoFixture(part2);
        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const first = await scanShowDirectory(db, library.id, show);
        expect(first.versionIds).toHaveLength(1);
        const firstFiles = await db.select().from(files);
        expect(firstFiles).toHaveLength(2);
        const part1File = firstFiles.find((file) =>
          file.path.endsWith("part1.mkv"),
        );
        if (!part1File) throw new Error("Fixture File missing.");
        const [firstVersion] = await db.select().from(versions);
        if (!firstVersion) throw new Error("Fixture Version missing.");

        await rm(part2);

        const second = await scanShowDirectory(db, library.id, show);
        expect(second.versionIds).toEqual([firstVersion.id]);
        expect(await db.select().from(files)).toHaveLength(2);

        const third = await scanShowDirectory(db, library.id, show, {
          reconcileMissing: true,
        });
        expect(third.versionIds).toEqual([firstVersion.id]);
        const keptFiles = await db.select().from(files);
        expect(keptFiles).toHaveLength(1);
        expect(keptFiles[0]).toMatchObject({
          id: part1File.id,
          order: 0,
          path: "Show/Season 01/Show S01E01 - part1.mkv",
        });
        const [keptVersion] = await db.select().from(versions);
        expect(keptVersion?.id).toBe(firstVersion.id);
        expect(keptVersion?.bytes).toBe(part1File.bytes);
        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.kind).sort()).toEqual([
          "episode",
          "season",
          "show",
        ]);
      });
    }));

  test("an emptied show folder revalidates before deleting the subtree", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const show = "Foundation";
        const seasonDir = join(root, show, "Season 01");
        await mkdir(seasonDir, { recursive: true });
        await createVideoFixture(join(seasonDir, "Foundation S01E01.mkv"));
        const [library] = await db
          .insert(libraries)
          .values({ name: "Shows", medium: "shows", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");

        const scanned = await scanShowDirectory(db, library.id, show);
        const showId = scanned.itemId;
        if (!showId) throw new Error("Initial scan produced no Show.");
        const itemBefore = await db.select().from(items);
        const episodeId = itemBefore.find((row) => row.kind === "episode")?.id;
        if (itemBefore.length !== 3 || !episodeId) {
          throw new Error("Initial scan produced no hierarchy.");
        }
        const [version] = await db.select().from(versions);
        if (!version) throw new Error("Initial scan produced no Version.");
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        await db.insert(progress).values({
          userId: admin.id,
          itemId: episodeId,
          versionId: version.id,
          format: "video",
          positionSeconds: 33,
        });
        const progressBefore = await db.select().from(progress);
        await rm(join(seasonDir, "Foundation S01E01.mkv"));

        await holdLibraryLock(url, library.id, async (release) => {
          const scanning = scanShowDirectory(db, library.id, show, {
            reconcileMissing: true,
          });
          await waitForBlockedScan(db);
          await createVideoFixture(join(seasonDir, "Foundation S01E02.mkv"));
          release();
          await expect(scanning).rejects.toThrow(
            "Library directory changed before scan write.",
          );
        });

        const itemRows = await db.select().from(items);
        expect(itemRows.map((row) => row.id).sort()).toEqual(
          itemBefore.map((row) => row.id).sort(),
        );
        expect(await db.select().from(versions)).toHaveLength(1);
        expect(await db.select().from(files)).toHaveLength(1);
        expect(await db.select().from(progress)).toEqual(progressBefore);
      });
    }));
});
