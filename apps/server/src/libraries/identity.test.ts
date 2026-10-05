import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { libraryConcurrencyKey, registerLibraryJobs } from "./jobs.ts";

const titleKeyMigration = "0017_item_title_key";
const drizzleFolder = new URL("../../drizzle", import.meta.url).pathname;
const fixturePath = new URL("./fixtures/pre-117-scan.json", import.meta.url)
  .pathname;

type Fixture = {
  tables: [string, Record<string, unknown>[]][];
  roots: Record<string, { files: string[] }>;
};

const fixture: Fixture = await Bun.file(fixturePath).json();

/** Applies every migration before the title_key migration. */
async function migrateBeforeTitleKey(db: Database) {
  const folder = await mkdtemp(join(tmpdir(), "pendia-migrations-"));
  try {
    await cp(drizzleFolder, folder, { recursive: true });
    const journalPath = join(folder, "meta/_journal.json");
    const journal: { entries: { tag: string }[] } =
      await Bun.file(journalPath).json();
    const cut = journal.entries.findIndex(
      (entry) => entry.tag === titleKeyMigration,
    );
    if (cut < 0) throw new Error("The title_key migration is missing.");
    journal.entries = journal.entries.slice(0, cut);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const rowsOf = (table: string) => {
  const found = fixture.tables.find(([name]) => name === table);
  return found?.[1] ?? [];
};

/** Reads one table's rows in a stable order. */
const snapshot = async (db: Database, table: string) => {
  const key = {
    movies: "item_id",
    shows: "item_id",
    seasons: "item_id",
    episodes: "item_id",
    item_ancestors: "ancestor_id, descendant_id",
  }[table];
  return db.execute<Record<string, unknown>>(
    sql`select * from ${sql.identifier(table)} order by ${sql.raw(key ?? "id")}`,
  );
};

/** One row's identity column value for before/after matching. */
const rowKey = (table: string, row: Record<string, unknown>) =>
  table === "item_ancestors"
    ? `${row.ancestor_id}/${row.descendant_id}`
    : String(row.id ?? row.item_id);

describe.skipIf(!databaseUrl)("pre-117 scan identity", () => {
  test("the captured scan migrates to title keys and rescans unchanged", () =>
    withDatabase(async (db) => {
      await migrateBeforeTitleKey(db);
      const dir = await mkdtemp(join(tmpdir(), "pendia-identity-"));
      try {
        const rootPaths = new Map<string, string>();
        for (const [placeholder, { files: relative }] of Object.entries(
          fixture.roots,
        )) {
          const rootPath = join(dir, placeholder.slice(6, -1).toLowerCase());
          rootPaths.set(placeholder, rootPath);
          for (const path of relative) {
            const target = join(rootPath, path);
            await mkdir(dirname(target), { recursive: true });
            await createVideoFixture(target);
          }
        }

        // Seed every captured table in FK-safe order, pointing library_roots
        // at the temp trees.
        for (const [table, rows] of fixture.tables) {
          const patched =
            table === "library_roots"
              ? rows.map((row) => ({
                  ...row,
                  path: rootPaths.get(String(row.path)) ?? row.path,
                }))
              : rows;
          if (patched.length === 0) continue;
          const json = JSON.stringify(patched).replaceAll("'", "''");
          await db.execute(
            sql`insert into ${sql.identifier(table)} select * from jsonb_populate_recordset(null::${sql.identifier(table)}, ${sql.raw(`'${json}'`)}::jsonb)`,
          );
        }

        const showId = String(
          rowsOf("items").find(
            (row) => row.kind === "show" && row.parent_id === null,
          )?.id,
        );
        const movieId = String(
          rowsOf("items").find((row) => row.kind === "movie")?.id,
        );
        const episodeId = String(
          rowsOf("items").find((row) => row.kind === "episode")?.id,
        );
        const versionOf = (itemId: string) =>
          String(rowsOf("versions").find((row) => row.item_id === itemId)?.id);

        const userId = Bun.randomUUIDv7();
        await db.execute(sql`
          insert into users (id, username, display_name, password_hash)
          values (${userId}, 'mia', 'Mia', 'hash')`);
        await db.execute(sql`
          insert into progress (id, user_id, item_id, version_id, format, position_seconds) values
            (${Bun.randomUUIDv7()}, ${userId}, ${episodeId}, ${versionOf(episodeId)}, 'video', 7),
            (${Bun.randomUUIDv7()}, ${userId}, ${movieId}, ${versionOf(movieId)}, 'video', 42)`);
        await db.execute(sql`
          insert into favourites (id, user_id, item_id)
          values (${Bun.randomUUIDv7()}, ${userId}, ${movieId})`);
        await db.execute(sql`
          insert into ratings (id, user_id, item_id, value)
          values (${Bun.randomUUIDv7()}, ${userId}, ${episodeId}, 8.5)`);
        await db.execute(sql`
          update items set title = 'Curated', overview = 'Kept', metadata_state = 'matched'
          where id in (${showId}, ${movieId})`);

        const tables = [
          "items",
          "item_ancestors",
          "movies",
          "shows",
          "seasons",
          "episodes",
          "segment_timelines",
          "versions",
          "files",
          "streams",
          "provider_ids",
          "progress",
          "favourites",
          "ratings",
        ];
        const before = new Map<string, Record<string, unknown>[]>();
        for (const table of tables)
          before.set(table, await snapshot(db, table));

        await migrateDatabase(db);

        // The migration only adds title_key, defaulting to ''.
        for (const table of tables) {
          const after = await snapshot(db, table);
          expect(after).toHaveLength(before.get(table)?.length ?? -1);
          for (const row of after) {
            const seeded = before
              .get(table)
              ?.find((old) => rowKey(table, old) === rowKey(table, row));
            expect({ ...row, title_key: undefined }).toMatchObject(
              seeded ?? {},
            );
          }
        }
        const keys = await db.execute<{ title_key: string }>(
          sql`select title_key from items`,
        );
        expect(new Set(keys.map((row) => row.title_key))).toEqual(
          new Set([""]),
        );

        // Rescan both Libraries through the job queue.
        const queue = createJobQueue(db);
        const registry = createJobRegistry();
        registerLibraryJobs(db, registry);
        for (const library of rowsOf("libraries")) {
          const libraryId = String(library.id);
          await queue.enqueue(
            { type: "scan", libraryId, path: "." },
            { concurrencyKey: libraryConcurrencyKey(libraryId) },
          );
          for (;;) {
            const claimed = await queue.claim(["scan"]);
            if (!claimed) break;
            await registry.run(claimed);
            await queue.complete(claimed);
          }
        }

        const afterItems = await snapshot(db, "items");
        expect(afterItems).toHaveLength(before.get("items")?.length ?? -1);
        for (const row of afterItems) {
          const seeded = before.get("items")?.find((old) => old.id === row.id);
          expect(seeded).toBeDefined();
          expect(row).toMatchObject({
            kind: seeded?.kind,
            parent_id: seeded?.parent_id,
            canonical_folder: seeded?.canonical_folder,
            title_key: "",
            title: seeded?.title,
            overview: seeded?.overview,
            year: seeded?.year,
            metadata_state: seeded?.metadata_state,
          });
        }

        for (const table of [
          "item_ancestors",
          "movies",
          "shows",
          "seasons",
          "episodes",
          "segment_timelines",
          "versions",
          "files",
          "streams",
          "provider_ids",
          "progress",
          "favourites",
          "ratings",
        ]) {
          expect(await snapshot(db, table)).toHaveLength(
            before.get(table)?.length ?? -1,
          );
        }

        const afterVersions = await snapshot(db, "versions");
        const versionsByItem = (rows: Record<string, unknown>[]) =>
          new Map(
            rowsOf("items").map((item) => [
              String(item.id),
              rows
                .filter((row) => row.item_id === item.id)
                .map((row) => row.id)
                .sort(),
            ]),
          );
        expect(versionsByItem(afterVersions)).toEqual(
          versionsByItem(before.get("versions") ?? []),
        );

        const afterFiles = await snapshot(db, "files");
        const fileShape = (row: Record<string, unknown>) => ({
          version_id: row.version_id,
          item_id: row.item_id,
          root_id: row.root_id,
          path: row.path,
          order: row.order,
        });
        expect(
          new Map(afterFiles.map((row) => [row.id, fileShape(row)])),
        ).toEqual(
          new Map(
            (before.get("files") ?? []).map((row) => [row.id, fileShape(row)]),
          ),
        );

        expect(
          new Set((await snapshot(db, "streams")).map((row) => row.id)),
        ).toEqual(new Set((before.get("streams") ?? []).map((row) => row.id)));
        expect(await snapshot(db, "provider_ids")).toEqual(
          before.get("provider_ids") ?? [],
        );
        for (const table of ["progress", "favourites", "ratings"]) {
          expect(await snapshot(db, table)).toEqual(before.get(table) ?? []);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }));
});
