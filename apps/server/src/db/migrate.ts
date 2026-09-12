import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDatabase, type Database } from "./client.ts";
import { groups, permissions } from "./schema/index.ts";

const migrationLockKey = 0x70656e646961n;

function migrationsFolder() {
  const candidates = [
    resolve(import.meta.dir, "../../drizzle"),
    resolve(import.meta.dir, "../drizzle"),
    resolve(dirname(process.execPath), "drizzle"),
  ];
  const folder = candidates.find((path) =>
    existsSync(resolve(path, "meta/_journal.json")),
  );
  if (!folder)
    throw new Error(
      "Migration assets are missing. Ship drizzle beside the Pendia binary.",
    );
  return folder;
}

/** Applies pending migrations and seeds built-in groups on one locked Postgres connection. */
export async function migrateDatabase(database: Database) {
  const folder = migrationsFolder();
  const connection = await database.$client.reserve();
  try {
    await connection`select pg_advisory_lock(${migrationLockKey})`;
    try {
      const db = drizzle({ client: connection });
      await migrate(db, { migrationsFolder: folder });
      await db
        .insert(groups)
        .values([
          { name: "admins", builtIn: true, permissions: [...permissions] },
          { name: "users", builtIn: true, permissions: ["view", "play"] },
        ])
        .onConflictDoNothing({ target: groups.name });
    } finally {
      await connection`select pg_advisory_unlock(${migrationLockKey})`;
    }
  } finally {
    connection.release();
  }
}

if (import.meta.main) {
  const database = createDatabase();
  try {
    await migrateDatabase(database.db);
  } finally {
    await database.close();
  }
}
