import { afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { listJobs } from "../jobs/queue.ts";
import { runKeyframeIndexJob } from "../libraries/keyframe-index.ts";
import { createDatabase, type Database } from "./client.ts";
import { migrateDatabase } from "./migrate.ts";

type Admin = ReturnType<typeof createDatabase>;

/** One admin pool per worker process for database creates, drops and the template lock. */
let sharedAdmin: Admin | undefined;
function admin() {
  sharedAdmin ??= createDatabase(databaseUrl, { max: 2 });
  return sharedAdmin;
}

/** The test Postgres URL; database tests skip locally without it and fail in CI. */
export const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("DATABASE_URL is required for database tests in CI.");
if (!databaseUrl)
  console.info(
    "Skipping database tests: set DATABASE_URL to a test Postgres server.",
  );

/** The advisory lock serializing template creation across parallel test workers. */
const templateLockKey = 0x74657374n; // "test"

/** A hash of every migration, so a stale template is never reused after schema changes. */
function templateName() {
  const folder = resolve(import.meta.dir, "../../drizzle");
  const hash = createHash("sha256");
  hash.update(readFileSync(join(folder, "meta/_journal.json")));
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    hash.update(readFileSync(join(folder, file)));
  }
  return `thalia_test_tpl_${hash.digest("hex").slice(0, 12)}`;
}

let templatePromise: Promise<string> | undefined;

/** Creates the migrated template database once per process, under an advisory lock so parallel workers share it. */
function ensureTemplate(admin: Admin): Promise<string> {
  templatePromise ??= (async () => {
    const name = templateName();
    const connection = await admin.db.$client.reserve();
    try {
      await connection`select pg_advisory_lock(${templateLockKey})`;
      const existing =
        await connection`select 1 from pg_database where datname = ${name}`;
      if (existing.length === 0) {
        const session = drizzle({ client: connection });
        await session.execute(sql`create database ${sql.identifier(name)}`);
        const url = new URL(databaseUrl ?? "");
        url.pathname = `/${name}`;
        const template = createDatabase(url.href);
        try {
          await migrateDatabase(template.db);
        } finally {
          await template.close();
        }
      }
    } finally {
      await connection`select pg_advisory_unlock(${templateLockKey})`;
      connection.release();
    }
    return name;
  })();
  return templatePromise;
}

const pendingDrops = new Set<Promise<void>>();
let flushRegistered = false;

/** Drops a test database off the test's path; the flush hook waits for it at file end. */
function scheduleDrop(name: string) {
  const attempt = () =>
    admin().db.execute(sql.raw(`drop database ${name} with (force)`));
  // The shared admin's pooled connection may have idled out; retry once.
  const drop = attempt()
    .catch(() => attempt())
    .then(() => undefined)
    .catch((error: unknown) =>
      console.error(`drop database ${name} failed:`, error),
    )
    .finally(() => pendingDrops.delete(drop));
  pendingDrops.add(drop);
  if (!flushRegistered) {
    flushRegistered = true;
    afterAll(async () => {
      while (pendingDrops.size > 0) await Promise.allSettled([...pendingDrops]);
    });
  }
}

/**
 * Runs a test against a uniquely named database that is dropped afterwards.
 * The database clones a fully migrated template unless `empty` is passed for
 * tests that drive migrations themselves.
 */
export async function withDatabase(
  run: (db: Database, url: string) => Promise<void>,
  options: { empty?: boolean } = {},
) {
  const name = `thalia_test_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const url = new URL(databaseUrl ?? "");
  url.pathname = `/${name}`;
  const database = createDatabase(url.href);
  let created = false;
  try {
    const source = options.empty ? undefined : await ensureTemplate(admin());
    await admin().db.execute(
      sql.raw(
        source === undefined
          ? `create database ${name}`
          : `create database ${name} template ${source}`,
      ),
    );
    created = true;
    await run(database.db, url.href);
  } finally {
    await database.close();
    if (created) scheduleDrop(name);
  }
}

/**
 * Runs every queued keyframe-index job. Scans only queue them now, so tests
 * that need an indexed Version call this instead of waiting on a worker.
 */
export async function runQueuedKeyframeIndexes(db: Database) {
  const queued = await listJobs(db, { state: "queued" });
  for (const job of queued)
    if (job.payload.type === "keyframe-index")
      await runKeyframeIndexJob(db, job.payload);
}
