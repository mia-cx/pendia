import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "./client.ts";

/** The test Postgres URL; database tests skip locally without it and fail in CI. */
export const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("DATABASE_URL is required for database tests in CI.");
if (!databaseUrl)
  console.info(
    "Skipping database tests: set DATABASE_URL to a test Postgres server.",
  );

/** Runs a test against a uniquely named database that is dropped afterwards. */
export async function withDatabase(
  run: (db: Database, url: string) => Promise<void>,
) {
  const admin = createDatabase(databaseUrl);
  const name = `pendia_test_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const url = new URL(databaseUrl ?? "");
  url.pathname = `/${name}`;
  const database = createDatabase(url.href);
  let created = false;
  try {
    await admin.db.execute(sql`create database ${sql.identifier(name)}`);
    created = true;
    await run(database.db, url.href);
  } finally {
    try {
      await database.close();
      if (created)
        await admin.db.execute(
          sql`drop database ${sql.identifier(name)} with (force)`,
        );
    } finally {
      await admin.close();
    }
  }
}
