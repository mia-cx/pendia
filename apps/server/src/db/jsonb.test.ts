import { describe, expect, test } from "bun:test";
import {
  eq,
  getTableColumns,
  getTableName,
  inArray,
  is,
  sql,
} from "drizzle-orm";
import {
  jsonb as legacyJsonb,
  type PgInsertValue,
  PgTable,
  pgTable,
} from "drizzle-orm/pg-core";
import type { Database } from "./client.ts";
import { migrateDatabase } from "./migrate.ts";
import * as schema from "./schema/index.ts";
import { databaseUrl, withDatabase } from "./testing.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Case = { table: PgTable; row: PgInsertValue<PgTable> };

// Typed per table, then widened so one loop can write them all.
const write = <T extends PgTable>(
  table: T,
  row: NoInfer<PgInsertValue<T>>,
): Case => ({ table, row });

const uuid = () => Bun.randomUUIDv7();

// One row per table with a jsonb column, and scalar settings. Foreign keys
// and triggers are off while these are written, so rows need no parents.
const cases = [
  write(schema.settings, { key: uuid(), value: { oidc: { a: 1 } } }),
  write(schema.settings, { key: uuid(), value: "plain" }),
  write(schema.settings, { key: uuid(), value: 3 }),
  write(schema.libraries, {
    name: "Movies",
    medium: "movies",
    rootPath: "/movies",
    configuration: { watch: true },
  }),
  write(schema.files, {
    versionId: uuid(),
    itemId: uuid(),
    libraryId: uuid(),
    path: uuid(),
    order: 0,
    bytes: 1n,
    modifiedAt: new Date(),
    chapters: [{ title: "One", startSeconds: 0, endSeconds: 1 }],
  }),
  write(schema.streams, {
    versionId: uuid(),
    index: 0,
    kind: "video",
    codec: "h264",
    disposition: { default: true },
  }),
  write(schema.probeCache, {
    libraryId: uuid(),
    path: uuid(),
    bytes: 1n,
    modifiedNs: 1n,
    result: {
      container: "matroska",
      durationSeconds: 1,
      keyframesSeconds: [0],
      chapters: [],
      streams: [],
    },
  }),
  write(schema.events, { kind: "test", payload: { kind: "test" } }),
  write(schema.transcoderCapabilities, {
    name: "node",
    address: "http://node",
    testedAt: new Date(),
    backends: [{ name: "cpu", codecs: ["h264"], toneMapping: [] }],
  }),
  write(schema.sessionRegistry, {
    userId: uuid(),
    itemId: uuid(),
    versionId: uuid(),
    playMethod: "remux",
    state: "playing",
    decision: { method: "stored", selection: { audio: 0 } },
  }),
  write(schema.jobs, {
    type: "probe",
    maxAttempts: 1,
    payload: { type: "probe", fileId: uuid() },
  }),
];

/** The case's table, its jsonb column and id, and the value the case writes. */
const target = ({ table, row }: Case) => {
  const columns = getTableColumns(table);
  const found = Object.entries(columns).find(
    ([, column]) => column.getSQLType() === "jsonb",
  );
  const { id } = columns;
  if (!found || !id) throw new Error(`${getTableName(table)} has no target.`);
  const [key, column] = found;
  const value = new Map<string, unknown>(Object.entries(row)).get(key);
  const label = `${getTableName(table)}.${column.name}`;
  return { table, column, id, value, label };
};

const jsonTypeOf = (value: unknown) =>
  Array.isArray(value) ? "array" : typeof value;

/** Runs `run` with foreign keys and triggers off, so rows need no parents. */
const unchecked = (db: Database, run: (tx: Transaction) => Promise<void>) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await run(tx);
  });

test("the jsonb cases cover every jsonb column in the schema", () => {
  const columns = Object.values(schema).flatMap((table) =>
    is(table, PgTable)
      ? Object.values(getTableColumns(table))
          .filter((column) => column.getSQLType() === "jsonb")
          .map((column) => `${getTableName(table)}.${column.name}`)
      : [],
  );
  const covered = cases.map((item) => target(item).label);
  expect(new Set(covered)).toEqual(new Set(columns));
});

describe.skipIf(!databaseUrl)("jsonb columns", () => {
  test("insert, update and upsert store JSON values, not JSON strings", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      for (const item of cases) {
        const { table, row } = item;
        const { column, id, value, label } = target(item);
        await unchecked(db, async (tx) => {
          const [inserted] = await tx
            .insert(table)
            .values(row)
            .returning({ id });
          const where = eq(id, inserted?.id);
          // Postgres reads the type, so a JSON string fails even though drizzle would parse it.
          const expectStored = async () => {
            const [read] = await tx.execute<{ type: string }>(
              sql`select jsonb_typeof(${column}) as type from ${table} where ${where}`,
            );
            expect([label, read?.type]).toEqual([label, jsonTypeOf(value)]);
          };
          await expectStored();
          await tx.update(table).set(row).where(where);
          await expectStored();
          await tx
            .insert(table)
            .values({ ...row, id: inserted?.id })
            .onConflictDoUpdate({ target: id, set: row });
          await expectStored();
          const [read] = await tx
            .select({ value: column })
            .from(table)
            .where(where);
          expect([label, read?.value]).toEqual([label, value]);
        });
      }
    }));

  test("the 0013 migration unwraps JSON strings and keeps plain strings", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      // jobs.payload always stored objects, and no drizzle writer stored a top-level number.
      const legacy = cases.filter((item) => {
        const { label, value } = target(item);
        return label !== "jobs.payload" && typeof value !== "number";
      });
      const ids = await Promise.all(
        legacy.map(async (item) => {
          const { table, row } = item;
          const { column, id, value } = target(item);
          // drizzle's own jsonb column is the old write path.
          const old = pgTable(getTableName(table), {
            value: legacyJsonb(column.name),
          });
          let written: unknown;
          await unchecked(db, async (tx) => {
            const [inserted] = await tx
              .insert(table)
              .values(row)
              .returning({ id });
            written = inserted?.id;
            await tx.update(old).set({ value }).where(sql`id = ${written}`);
          });
          return written;
        }),
      );
      const plain = ["tmdb-key", "{not json", '"unterminated'];
      for (const text of plain)
        await db.insert(schema.settings).values({
          key: text,
          value: sql`to_jsonb(${text}::text)`,
        });
      const types = await Promise.all(
        legacy.map(async (item, index) => {
          const { table, column } = target(item);
          const [read] = await db.execute<{ type: string }>(
            sql`select jsonb_typeof(${column}) as type from ${table} where id = ${ids[index]}`,
          );
          return read?.type;
        }),
      );
      expect(new Set(types)).toEqual(new Set(["string"]));

      const migration = await Bun.file(
        new URL("../../drizzle/0013_jsonb_values.sql", import.meta.url),
      ).text();
      for (const statement of migration.split("--> statement-breakpoint"))
        await db.execute(sql.raw(statement));

      for (const [index, item] of legacy.entries()) {
        const { table, column, id, value, label } = target(item);
        const [read] = await db.execute<{ type: string }>(
          sql`select jsonb_typeof(${column}) as type from ${table} where id = ${ids[index]}`,
        );
        const [row] = await db
          .select({ value: column })
          .from(table)
          .where(eq(id, ids[index]));
        expect([label, read?.type, row?.value]).toEqual([
          label,
          jsonTypeOf(value),
          value,
        ]);
      }
      const kept = await db
        .select({ key: schema.settings.key, value: schema.settings.value })
        .from(schema.settings)
        .where(inArray(schema.settings.key, plain));
      expect(new Map(kept.map((row) => [row.key, row.value]))).toEqual(
        new Map(plain.map((text) => [text, text])),
      );
    }));
});
