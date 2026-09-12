import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { startApiServer } from "../api.ts";
import { type Database, probeDatabase } from "./client.ts";
import { migrateDatabase } from "./migrate.ts";
import {
  contributors,
  episodes,
  favourites,
  files,
  groups,
  itemAncestors,
  items,
  jobs,
  libraries,
  movies,
  permissions,
  progress,
  providerIds,
  ratings,
  seasons,
  segmentTimelines,
  sessions,
  shows,
  streams,
  userGroups,
  users,
  versions,
} from "./schema/index.ts";
import { databaseUrl, withDatabase } from "./testing.ts";
import { deleteItemSubtree, insertItem, moveItem } from "./tree.ts";

async function fixture(db: Database) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Shows", medium: "shows", rootPath: "/shows" })
    .returning();
  const [movieLibrary] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: "/movies" })
    .returning();
  if (!library || !movieLibrary) throw new Error("Fixture libraries missing.");
  const base = {
    libraryId: library.id,
    title: "Fixture",
    canonicalFolder: "/shows/fixture",
  };
  return db.transaction(async (tx) => {
    const first = await insertItem(tx, {
      ...base,
      kind: "show",
      extension: {},
    });
    const second = await insertItem(tx, {
      ...base,
      kind: "show",
      extension: {},
    });
    const season = await insertItem(tx, {
      ...base,
      kind: "season",
      parentId: first.id,
      extension: { seasonNumber: 1 },
    });
    const spare = await insertItem(tx, {
      ...base,
      kind: "season",
      parentId: first.id,
      extension: { seasonNumber: 0 },
    });
    const episode = await insertItem(tx, {
      ...base,
      kind: "episode",
      parentId: season.id,
      extension: { episodeNumber: 1, episodeEndNumber: 2 },
    });
    const sibling = await insertItem(tx, {
      ...base,
      kind: "episode",
      parentId: season.id,
      extension: { episodeNumber: 3 },
    });
    const movie = await insertItem(tx, {
      ...base,
      libraryId: movieLibrary.id,
      kind: "movie",
      extension: {},
    });
    return { base, first, second, season, spare, episode, sibling, movie };
  });
}

async function expectClosure(db: Database) {
  const expected = await db.$client<
    {
      ancestor_id: string;
      descendant_id: string;
      depth: number;
    }[]
  >`with recursive tree as (
    select id as ancestor_id, id as descendant_id, 0 as depth from items
    union all
    select tree.ancestor_id, items.id, tree.depth + 1 from tree join items on items.parent_id = tree.descendant_id
  ) select * from tree order by ancestor_id, descendant_id`;
  const actual = await db
    .select({
      ancestor_id: itemAncestors.ancestorId,
      descendant_id: itemAncestors.descendantId,
      depth: itemAncestors.depth,
    })
    .from(itemAncestors)
    .orderBy(itemAncestors.ancestorId, itemAncestors.descendantId);
  expect(actual).toEqual(Array.from(expected));
}

async function episodesUnder(db: Database, showId: string) {
  return db
    .select({ id: items.id })
    .from(itemAncestors)
    .innerJoin(items, eq(items.id, itemAncestors.descendantId))
    .where(and(eq(itemAncestors.ancestorId, showId), eq(items.kind, "episode")))
    .orderBy(items.id);
}

async function migrationState(db: Database) {
  return {
    journal: Array.from(
      await db.execute(
        sql`select * from drizzle.__drizzle_migrations order by id`,
      ),
    ),
    tables: Array.from(
      await db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      ),
    ),
    groups: await db.select().from(groups).orderBy(groups.name),
    extensions: Array.from(
      await db.execute(
        sql`select extname from pg_extension where extname in ('pg_trgm', 'btree_gist') order by extname`,
      ),
    ),
  };
}

describe.skipIf(!databaseUrl)("Postgres schema", () => {
  test("readiness passes against a live database while liveness stays available", () =>
    withDatabase(async (_db, url) => {
      const server = startApiServer(() => probeDatabase(url), 0);
      const base = `http://127.0.0.1:${server.port}`;
      try {
        const ready = await fetch(`${base}/readyz`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ status: "ready" });
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
      } finally {
        await server.stop(true);
      }
    }));

  test("migrates an empty database once and preserves the second run", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const before = await migrationState(db);
      expect(before.journal).toHaveLength(1);
      expect(before.tables).toHaveLength(32);
      expect(before.extensions).toEqual([
        { extname: "btree_gist" },
        { extname: "pg_trgm" },
      ]);
      expect(before.groups).toMatchObject([
        { name: "admins", builtIn: true, permissions: [...permissions] },
        { name: "users", builtIn: true, permissions: ["view", "play"] },
      ]);
      await migrateDatabase(db);
      expect(await migrationState(db)).toEqual(before);
    }));

  test(
    "two runner processes race and apply one migration set",
    () =>
      withDatabase(async (db, url) => {
        const runners = Array.from({ length: 2 }, () =>
          Bun.spawn({
            cmd: [
              process.execPath,
              new URL("./migrate.ts", import.meta.url).pathname,
            ],
            env: { ...process.env, DATABASE_URL: url },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          }),
        );
        try {
          const results = await Promise.all(
            runners.map(async (runner) => ({
              code: await runner.exited,
              stderr: await new Response(runner.stderr).text(),
            })),
          );
          expect(results).toEqual([
            { code: 0, stderr: "" },
            { code: 0, stderr: "" },
          ]);
          const state = await migrationState(db);
          expect(state.journal).toHaveLength(1);
          expect(state.tables).toHaveLength(32);
          expect(state.groups).toHaveLength(2);
        } finally {
          for (const runner of runners) runner.kill();
          await Promise.all(runners.map((runner) => runner.exited));
        }
      }),
    15_000,
  );

  test("inserts, moves and deletes a fixture tree with matching closure rows", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const f = await fixture(db);
      await expectClosure(db);
      expect(await episodesUnder(db, f.first.id)).toEqual([
        { id: f.episode.id },
        { id: f.sibling.id },
      ]);
      await expect(moveItem(db, f.first.id, f.episode.id)).rejects.toThrow(
        "subtree",
      );
      await expect(moveItem(db, f.episode.id, f.second.id)).rejects.toThrow(
        "Parent kind",
      );
      await expect(moveItem(db, f.season.id, f.movie.id)).rejects.toThrow(
        "Parent kind or library",
      );
      await expect(
        insertItem(db, { ...f.base, kind: "movie", extension: {} }),
      ).rejects.toThrow("medium");

      await moveItem(db, f.season.id, f.second.id);
      await expectClosure(db);
      expect(await episodesUnder(db, f.first.id)).toEqual([]);
      expect(await episodesUnder(db, f.second.id)).toHaveLength(2);
      expect(
        await db.select().from(seasons).where(eq(seasons.itemId, f.season.id)),
      ).toMatchObject([{ showId: f.second.id }]);
      await moveItem(db, f.episode.id, f.spare.id);
      await expectClosure(db);
      expect(
        await db
          .select()
          .from(episodes)
          .where(eq(episodes.itemId, f.episode.id)),
      ).toMatchObject([{ seasonId: f.spare.id }]);
      await deleteItemSubtree(db, f.first.id);
      await expectClosure(db);
      expect(await db.select().from(items).orderBy(items.id)).toMatchObject([
        { id: f.second.id },
        { id: f.season.id },
        { id: f.sibling.id },
        { id: f.movie.id },
      ]);
      expect(await db.select().from(shows)).toHaveLength(1);
      expect(await db.select().from(seasons)).toHaveLength(1);
      expect(await db.select().from(episodes)).toMatchObject([
        { itemId: f.sibling.id },
      ]);
      expect(await db.select().from(movies)).toHaveLength(1);
    }));

  test("enforces provider uniqueness, numbering and extension kinds", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const f = await fixture(db);
      const [contributor] = await db
        .insert(contributors)
        .values({ name: "Actor" })
        .returning();
      if (!contributor) throw new Error("Contributor missing.");
      const provider = { provider: "tmdb", value: "123", itemId: f.first.id };
      await db.insert(providerIds).values(provider);
      await expect(
        db.insert(providerIds).values(provider).execute(),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await db.insert(providerIds).values({ ...provider, itemId: f.second.id });
      const creditProvider = {
        provider: "tmdb",
        value: "123",
        contributorId: contributor.id,
      };
      await db.insert(providerIds).values(creditProvider);
      await expect(
        db.insert(providerIds).values(creditProvider).execute(),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await expect(
        db.insert(movies).values({ itemId: f.first.id }).execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
      await expect(
        insertItem(db, {
          ...f.base,
          kind: "season",
          parentId: f.first.id,
          extension: { seasonNumber: 1 },
        }),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await expect(
        insertItem(db, {
          ...f.base,
          kind: "episode",
          parentId: f.season.id,
          extension: { episodeNumber: 1 },
        }),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await expect(
        insertItem(db, {
          ...f.base,
          kind: "episode",
          parentId: f.season.id,
          extension: { episodeNumber: 4, episodeEndNumber: 3 },
        }),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      expect(await db.select().from(items)).toHaveLength(7);
      await expect(
        insertItem(db, {
          ...f.base,
          kind: "episode",
          parentId: f.season.id,
          extension: { episodeNumber: 2 },
        }),
      ).rejects.toMatchObject({ cause: { errno: "23P01" } });
      await expectClosure(db);
      await expect(
        db
          .insert(segmentTimelines)
          .values({
            itemId: f.movie.id,
            cutKey: "bad",
            boundariesSeconds: [0, 3, 2],
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
    }));

  test("keeps the queue dispatch type consistent with its payload", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const payload = { type: "probe", fileId: Bun.randomUUIDv7() } as const;
      await expect(
        db
          .insert(jobs)
          .values({ type: "store", payload, maxAttempts: 3 })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      const [job] = await db
        .insert(jobs)
        .values({ type: payload.type, payload, maxAttempts: 3 })
        .returning();
      expect(job?.payload).toEqual(payload);
    }));

  test("rejects invalid Version kinds, formats and mismatched ownership", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const f = await fixture(db);
      const values = {
        itemId: f.movie.id,
        itemKind: f.movie.kind,
        libraryId: f.movie.libraryId,
        label: "Original",
        format: "video",
        bytes: 100n,
      } as const;
      for (const item of [f.movie, f.episode]) {
        await expect(
          db
            .insert(versions)
            .values({
              ...values,
              itemId: item.id,
              itemKind: item.kind,
              libraryId: item.libraryId,
              format: "audio",
            })
            .execute(),
        ).rejects.toMatchObject({ cause: { errno: "23514" } });
      }
      for (const container of [f.first, f.season]) {
        await expect(
          db
            .insert(versions)
            .values({
              ...values,
              itemId: container.id,
              itemKind: container.kind,
              libraryId: container.libraryId,
            })
            .execute(),
        ).rejects.toMatchObject({ cause: { errno: "23514" } });
        await expect(
          db
            .insert(versions)
            .values({
              ...values,
              itemId: container.id,
              itemKind: "movie",
              libraryId: container.libraryId,
            })
            .execute(),
        ).rejects.toMatchObject({ cause: { errno: "23503" } });
      }
      await expect(
        db
          .insert(versions)
          .values({ ...values, libraryId: f.base.libraryId })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
      const [source] = await db.insert(versions).values(values).returning();
      if (!source) throw new Error("Source Version missing.");
      await expect(
        db
          .insert(streams)
          .values({
            versionId: source.id,
            index: 0,
            kind: "video",
            codec: "h264",
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await expect(
        db
          .insert(files)
          .values({
            versionId: source.id,
            itemId: source.itemId,
            libraryId: f.base.libraryId,
            path: "wrong.mkv",
            order: 0,
            bytes: 100n,
            modifiedAt: new Date(),
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
      const fileValues = {
        versionId: source.id,
        itemId: source.itemId,
        libraryId: source.libraryId,
        path: "source.mkv",
        order: 0,
        bytes: 100n,
        modifiedAt: new Date(),
      };
      await expect(
        db
          .insert(files)
          .values({ ...fileValues, itemId: f.episode.id })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
      const [sourceFile] = await db
        .insert(files)
        .values(fileValues)
        .returning();
      const [otherVersion] = await db
        .insert(versions)
        .values({ ...values, label: "Other" })
        .returning();
      if (!sourceFile || !otherVersion)
        throw new Error("File ownership fixture missing.");
      await expect(
        db
          .insert(files)
          .values({ ...fileValues, versionId: otherVersion.id })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await expect(
        db
          .insert(streams)
          .values({
            versionId: otherVersion.id,
            fileId: sourceFile.id,
            index: 0,
            kind: "video",
            codec: "h264",
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
      const [timeline] = await db
        .insert(segmentTimelines)
        .values({
          itemId: f.episode.id,
          cutKey: "original",
          boundariesSeconds: [0, 5],
        })
        .returning();
      if (!timeline) throw new Error("Timeline missing.");
      await expect(
        db
          .insert(versions)
          .values({
            ...values,
            itemId: f.episode.id,
            itemKind: f.episode.kind,
            libraryId: f.episode.libraryId,
            origin: "stored",
            sourceFileId: sourceFile.id,
            segmentTimelineId: timeline.id,
            timelineAligned: true,
            storedFolder: "/stored/episode",
            rung: "720p",
            complete: true,
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
    }));

  test("checks stored timelines and rungs, cascades File streams and preserves progress on Version deletion", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const f = await fixture(db);
      const [user] = await db
        .insert(users)
        .values({
          username: "viewer",
          displayName: "Viewer",
          passwordHash: "fixture",
        })
        .returning();
      const [version] = await db
        .insert(versions)
        .values({
          itemId: f.movie.id,
          itemKind: f.movie.kind,
          libraryId: f.movie.libraryId,
          label: "Original",
          format: "video",
          bytes: 100n,
        })
        .returning();
      if (!user || !version) throw new Error("Playback fixture missing.");
      const [file] = await db
        .insert(files)
        .values({
          versionId: version.id,
          itemId: version.itemId,
          libraryId: f.movie.libraryId,
          path: "movie.mkv",
          order: 0,
          bytes: 100n,
          modifiedAt: new Date(),
        })
        .returning();
      if (!file) throw new Error("File missing.");
      const [secondFile] = await db
        .insert(files)
        .values({
          versionId: version.id,
          itemId: version.itemId,
          libraryId: f.movie.libraryId,
          path: "movie-part2.mkv",
          order: 1,
          bytes: 100n,
          modifiedAt: new Date(),
        })
        .returning();
      if (!secondFile) throw new Error("Second File missing.");
      const [timeline] = await db
        .insert(segmentTimelines)
        .values({
          itemId: f.movie.id,
          cutKey: "original",
          boundariesSeconds: [0, 2.5, 5],
        })
        .returning();
      if (!timeline) throw new Error("Timeline missing.");
      await db
        .update(versions)
        .set({ segmentTimelineId: timeline.id })
        .where(eq(versions.id, version.id));
      const [otherCut] = await db
        .insert(segmentTimelines)
        .values({
          itemId: f.movie.id,
          cutKey: "other-cut",
          boundariesSeconds: [0, 3, 6],
        })
        .returning();
      if (!otherCut) throw new Error("Other cut missing.");
      await db
        .update(versions)
        .set({ timelineAligned: true })
        .where(eq(versions.id, version.id));
      await expect(
        db
          .update(versions)
          .set({ segmentTimelineId: otherCut.id })
          .where(eq(versions.id, version.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await db
        .update(versions)
        .set({ segmentTimelineId: otherCut.id, timelineAligned: false })
        .where(eq(versions.id, version.id));
      await db
        .update(versions)
        .set({ segmentTimelineId: timeline.id })
        .where(eq(versions.id, version.id));
      const storedValues = {
        segmentTimelineId: timeline.id,
        timelineAligned: true,
        origin: "stored",
        sourceFileId: file.id,
        storedFolder: "/stored/movie",
        rung: "720p",
        complete: true,
      } as const;
      const storedVersion = {
        itemId: f.movie.id,
        itemKind: f.movie.kind,
        libraryId: f.movie.libraryId,
        label: "720p",
        format: "video",
        bytes: 50n,
        ...storedValues,
      } satisfies typeof versions.$inferInsert;
      await expect(
        db
          .insert(versions)
          .values({ ...storedVersion, segmentTimelineId: otherCut.id })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      const race = await Promise.allSettled([
        db.insert(versions).values(storedVersion).execute(),
        db
          .update(versions)
          .set({ segmentTimelineId: otherCut.id })
          .where(eq(versions.id, version.id))
          .execute(),
      ]);
      expect(
        race.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        race.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      await db.delete(versions).where(eq(versions.sourceFileId, file.id));
      await db
        .update(versions)
        .set({ segmentTimelineId: timeline.id })
        .where(eq(versions.id, version.id));
      const [stored] = await db
        .insert(versions)
        .values(storedVersion)
        .returning();
      if (!stored) throw new Error("Stored Version missing.");
      expect(stored.segmentTimelineId).toBe(timeline.id);
      await expect(
        db
          .update(segmentTimelines)
          .set({ boundariesSeconds: [0, 3, 5] })
          .where(eq(segmentTimelines.id, timeline.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await expect(
        db
          .update(versions)
          .set({ segmentTimelineId: otherCut.id })
          .where(eq(versions.id, version.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      const [otherVersion] = await db
        .insert(versions)
        .values({
          itemId: f.movie.id,
          itemKind: f.movie.kind,
          libraryId: f.movie.libraryId,
          label: "Other cut",
          format: "video",
          bytes: 100n,
          segmentTimelineId: otherCut.id,
        })
        .returning();
      if (!otherVersion) throw new Error("Other Version missing.");
      await expect(
        db
          .update(files)
          .set({ versionId: otherVersion.id })
          .where(eq(files.id, file.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await db.delete(versions).where(eq(versions.id, otherVersion.id));
      await expect(
        db
          .update(versions)
          .set({ segmentTimelineId: otherCut.id })
          .where(eq(versions.id, stored.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await expect(
        db.insert(versions).values(storedVersion).execute(),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await expect(
        db
          .insert(files)
          .values({
            versionId: stored.id,
            itemId: stored.itemId,
            libraryId: f.movie.libraryId,
            path: "segment.ts",
            order: 0,
            bytes: 50n,
            modifiedAt: new Date(),
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await expect(
        db
          .update(versions)
          .set(storedValues)
          .where(eq(versions.id, version.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await db.insert(streams).values([
        {
          versionId: version.id,
          fileId: file.id,
          index: 0,
          kind: "video",
          codec: "h264",
        },
        { versionId: stored.id, index: 0, kind: "video", codec: "h264" },
        { versionId: stored.id, index: 1, kind: "audio", codec: "aac" },
        {
          versionId: version.id,
          fileId: secondFile.id,
          index: 0,
          kind: "video",
          codec: "h264",
        },
      ]);
      await expect(
        db
          .update(streams)
          .set({ fileId: null })
          .where(eq(streams.fileId, file.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await expect(
        db
          .update(versions)
          .set({
            origin: "imported",
            sourceFileId: null,
            storedFolder: null,
            rung: null,
            complete: null,
          })
          .where(eq(versions.id, stored.id))
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23514" } });
      await expect(
        db
          .insert(streams)
          .values({
            versionId: version.id,
            fileId: file.id,
            index: 0,
            kind: "video",
            codec: "h264",
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await expect(
        db
          .insert(streams)
          .values({
            versionId: stored.id,
            index: 0,
            kind: "video",
            codec: "h264",
          })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23505" } });
      await db.delete(files).where(eq(files.id, file.id));
      expect(
        await db.select().from(streams).orderBy(streams.fileId),
      ).toMatchObject([
        { versionId: version.id, fileId: secondFile.id, kind: "video" },
      ]);
      expect(await db.select().from(versions)).toMatchObject([
        { id: version.id },
      ]);
      expect(await db.select().from(files)).toMatchObject([
        { id: secondFile.id },
      ]);
      await db.delete(files).where(eq(files.id, secondFile.id));
      expect(await db.select().from(streams)).toEqual([]);
      expect(await db.select().from(files)).toEqual([]);
      const mark = {
        userId: user.id,
        itemId: f.movie.id,
        versionId: version.id,
        format: "video",
        positionSeconds: 42.5,
        completed: true,
        playCount: 2,
      } as const;
      await expect(
        db
          .insert(progress)
          .values({ ...mark, itemId: f.episode.id })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
      await expect(
        db
          .insert(progress)
          .values({ ...mark, format: "audio" })
          .execute(),
      ).rejects.toMatchObject({ cause: { errno: "23503" } });
      await db.insert(progress).values(mark);
      await db
        .insert(favourites)
        .values({ userId: user.id, itemId: f.movie.id });
      await db
        .insert(ratings)
        .values({ userId: user.id, itemId: f.movie.id, value: "8.5" });
      const before = await db.select().from(progress);
      await db.delete(versions).where(eq(versions.id, version.id));
      expect(await db.select().from(versions)).toEqual([]);
      expect(await db.select().from(files)).toEqual([]);
      expect(await db.select().from(streams)).toEqual([]);
      expect(await db.select().from(progress)).toEqual(
        before.map((row) => ({ ...row, versionId: null })),
      );
      expect(await db.select().from(favourites)).toHaveLength(1);
      expect(await db.select().from(ratings)).toHaveLength(1);
      await deleteItemSubtree(db, f.movie.id);
      expect(await db.select().from(progress)).toEqual([]);
      expect(await db.select().from(favourites)).toEqual([]);
      expect(await db.select().from(ratings)).toEqual([]);
      const [group] = await db
        .select()
        .from(groups)
        .where(eq(groups.name, "users"));
      if (!group) throw new Error("Users group missing.");
      await db
        .insert(userGroups)
        .values({ userId: user.id, groupId: group.id });
      await db.insert(sessions).values({
        userId: user.id,
        tokenHash: Buffer.alloc(32),
        clientName: "test",
        deviceId: "test",
        deviceName: "test",
      });
      await db
        .insert(favourites)
        .values({ userId: user.id, itemId: f.episode.id });
      await db.delete(users).where(eq(users.id, user.id));
      expect(await db.select().from(userGroups)).toEqual([]);
      expect(await db.select().from(sessions)).toEqual([]);
      expect(await db.select().from(favourites)).toEqual([]);
    }));
});
