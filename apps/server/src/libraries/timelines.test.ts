import { describe, expect, test } from "bun:test";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  libraries,
  segmentTimelines,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { withVideoFixture } from "../mediums/video-common/fixtures.ts";
import { createKeyframeFixture } from "../mediums/video-common/keyframe-fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { scanDirectory } from "./scan.ts";

const folder = "Movie (2000)";
const member = (name: string) => `${folder}/${name}`;

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

async function timelines(db: Database) {
  return db
    .select()
    .from(segmentTimelines)
    .orderBy(asc(segmentTimelines.cutKey));
}

async function versionsByPath(db: Database, itemId: string) {
  const rows = await db
    .select({ version: versions, path: files.path })
    .from(versions)
    .innerJoin(files, eq(files.versionId, versions.id))
    .where(eq(versions.itemId, itemId))
    .orderBy(asc(files.path));
  return new Map(rows.map((row) => [row.path, row.version]));
}

describe.skipIf(!databaseUrl)("persistScanTimelines", () => {
  test("establishes one original timeline from the first Version and reuses it", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createKeyframeFixture(join(dir, "z-original.mp4"));
        await withLibrary(db, root, async (library) => {
          const first = await scanDirectory(db, library.id, folder);
          const itemId = first.itemId ?? "";
          const [timeline] = await timelines(db);
          expect(timeline).toMatchObject({
            itemId,
            cutKey: "original",
            boundariesSeconds: [0, 4, 8, 12],
          });
          const source = (await versionsByPath(db, itemId)).get(
            member("z-original.mp4"),
          );
          expect(source).toMatchObject({
            keyframesSeconds: [0, 2, 4, 6, 8, 10],
            lazyIndexPending: false,
            segmentTimelineId: timeline?.id ?? null,
            timelineAligned: true,
          });

          await createKeyframeFixture(join(dir, "a-added.mp4"), { gop: 25 });
          await createKeyframeFixture(join(dir, "b-unaligned.mp4"), {
            gop: 75,
          });
          const second = await scanDirectory(db, library.id, folder);
          const persisted = await timelines(db);
          expect(persisted).toHaveLength(1);
          expect(persisted[0]?.id).toBe(timeline?.id);
          expect(persisted[0]?.boundariesSeconds).toEqual([0, 4, 8, 12]);
          const byPath = await versionsByPath(db, itemId);
          expect(byPath.get(member("z-original.mp4"))?.id).toBe(source?.id);
          for (const name of [
            "z-original.mp4",
            "a-added.mp4",
            "b-unaligned.mp4",
          ]) {
            expect(byPath.get(member(name))?.segmentTimelineId).toBe(
              timeline?.id,
            );
          }
          expect(byPath.get(member("a-added.mp4"))).toMatchObject({
            keyframesSeconds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            timelineAligned: true,
          });
          expect(byPath.get(member("b-unaligned.mp4"))).toMatchObject({
            keyframesSeconds: [0, 3, 6, 9],
            timelineAligned: false,
          });

          const third = await scanDirectory(db, library.id, folder);
          expect(third.versionIds).toEqual(second.versionIds);
          expect(await timelines(db)).toHaveLength(1);
          expect(
            (await versionsByPath(db, itemId)).get(member("z-original.mp4"))
              ?.keyframesSeconds,
          ).toEqual([0, 2, 4, 6, 8, 10]);
        });
      });
    }));

  test("keeps the timeline and Version when the source file is replaced", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createKeyframeFixture(join(dir, "movie.mp4"));
        await withLibrary(db, root, async (library) => {
          const first = await scanDirectory(db, library.id, folder);
          const itemId = first.itemId ?? "";
          const [timeline] = await timelines(db);
          const before = (await versionsByPath(db, itemId)).get(
            member("movie.mp4"),
          );
          expect(before).toMatchObject({
            segmentTimelineId: timeline?.id ?? null,
            timelineAligned: true,
          });

          const replacement = join(root, "replacement.mp4");
          await createKeyframeFixture(replacement, { gop: 75 });
          await rename(replacement, join(dir, "movie.mp4"));
          await scanDirectory(db, library.id, folder);
          const after = (await versionsByPath(db, itemId)).get(
            member("movie.mp4"),
          );
          expect(await timelines(db)).toMatchObject([
            { id: timeline?.id, boundariesSeconds: [0, 4, 8, 12] },
          ]);
          expect(after).toMatchObject({
            id: before?.id,
            keyframesSeconds: [0, 3, 6, 9],
            lazyIndexPending: false,
            segmentTimelineId: timeline?.id,
            timelineAligned: false,
            durationSeconds: 12,
          });
        });
      });
    }));

  test("defers a cut's timeline until its first Version is indexed", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createKeyframeFixture(join(dir, "z-first.mp4"), {
          fragmented: true,
        });
        await withLibrary(db, root, async (library) => {
          const first = await scanDirectory(db, library.id, folder);
          const itemId = first.itemId ?? "";
          expect(
            (await versionsByPath(db, itemId)).get(member("z-first.mp4")),
          ).toMatchObject({
            keyframesSeconds: null,
            lazyIndexPending: true,
            segmentTimelineId: null,
            timelineAligned: false,
          });
          expect(await timelines(db)).toHaveLength(0);

          await createKeyframeFixture(join(dir, "a-later.mp4"));
          await scanDirectory(db, library.id, folder);
          const midway = await versionsByPath(db, itemId);
          expect(midway.get(member("a-later.mp4"))).toMatchObject({
            keyframesSeconds: [0, 2, 4, 6, 8, 10],
            lazyIndexPending: false,
            segmentTimelineId: null,
            timelineAligned: false,
          });
          expect(await timelines(db)).toHaveLength(0);

          const replacement = join(root, "replacement.mp4");
          await createKeyframeFixture(replacement);
          await rename(replacement, join(dir, "z-first.mp4"));
          await scanDirectory(db, library.id, folder);
          const [timeline] = await timelines(db);
          expect(timeline).toMatchObject({
            cutKey: "original",
            boundariesSeconds: [0, 4, 8, 12],
          });
          const byPath = await versionsByPath(db, itemId);
          for (const name of ["z-first.mp4", "a-later.mp4"]) {
            expect(byPath.get(member(name))).toMatchObject({
              keyframesSeconds: [0, 2, 4, 6, 8, 10],
              lazyIndexPending: false,
              segmentTimelineId: timeline?.id ?? null,
              timelineAligned: true,
            });
          }
        });
      });
    }));

  test("derives independent timelines per edition cut, case-insensitively", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        await createKeyframeFixture(join(dir, "Movie.mp4"));
        await createKeyframeFixture(join(dir, "Movie {edition-Director}.mp4"), {
          gop: 75,
        });
        await createKeyframeFixture(join(dir, "Movie {edition-director}.mp4"), {
          gop: 25,
        });
        await withLibrary(db, root, async (library) => {
          const result = await scanDirectory(db, library.id, folder);
          const itemId = result.itemId ?? "";
          const [director, original] = await timelines(db);
          expect(director).toMatchObject({
            cutKey: "director",
            boundariesSeconds: [0, 3, 6, 9, 12],
          });
          expect(original).toMatchObject({
            cutKey: "original",
            boundariesSeconds: [0, 4, 8, 12],
          });
          const byPath = await versionsByPath(db, itemId);
          expect(byPath.get(member("Movie.mp4"))).toMatchObject({
            segmentTimelineId: original?.id ?? null,
            timelineAligned: true,
          });
          expect(
            byPath.get(member("Movie {edition-Director}.mp4")),
          ).toMatchObject({
            segmentTimelineId: director?.id ?? null,
            timelineAligned: true,
          });
          expect(
            byPath.get(member("Movie {edition-director}.mp4")),
          ).toMatchObject({
            segmentTimelineId: director?.id ?? null,
            timelineAligned: true,
          });
        });
      });
    }));

  test("two simultaneous scans establish one timeline", () =>
    withDatabase(async (_db, url) => {
      const db = createDatabase(url);
      try {
        await migrateDatabase(db.db);
        await withVideoFixture(async (root) => {
          const dir = join(root, folder);
          await mkdir(dir, { recursive: true });
          await createKeyframeFixture(join(dir, "movie.mp4"));
          await withLibrary(db.db, root, async (library) => {
            const first = createDatabase(url);
            const second = createDatabase(url);
            try {
              const results = await Promise.all([
                scanDirectory(first.db, library.id, folder),
                scanDirectory(second.db, library.id, folder),
              ]);
              expect(results[0]?.versionIds).toEqual(results[1]?.versionIds);
              const persisted = await timelines(db.db);
              expect(persisted).toHaveLength(1);
              const byPath = await versionsByPath(
                db.db,
                results[0]?.itemId ?? "",
              );
              expect(byPath.get(member("movie.mp4"))).toMatchObject({
                segmentTimelineId: persisted[0]?.id ?? null,
                timelineAligned: true,
              });
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

  test("preserves a nonzero first index without deriving a timeline", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const absolute = join(dir, "movie.mkv");
        const proc = Bun.spawn(
          [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=160x90:r=25:d=4",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "50",
            "-keyint_min",
            "50",
            "-sc_threshold",
            "0",
            "-bf",
            "0",
            "-output_ts_offset",
            "5",
            absolute,
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        const [stderr, , exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        if (exitCode !== 0) {
          throw new Error(`ffmpeg failed (${exitCode}): ${stderr.trim()}`);
        }
        await withLibrary(db, root, async (library) => {
          const result = await scanDirectory(db, library.id, folder);
          const expected = (await probeVideo(absolute)).keyframesSeconds;
          expect(expected).toEqual([5, 7]);
          const byPath = await versionsByPath(db, result.itemId ?? "");
          expect(byPath.get(member("movie.mkv"))).toMatchObject({
            keyframesSeconds: expected,
            lazyIndexPending: false,
            segmentTimelineId: null,
            timelineAligned: false,
          });
          expect(await timelines(db)).toHaveLength(0);
        });
      });
    }));
});
