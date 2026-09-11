import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema/index.ts";

/** Creates a lazy Postgres client and its close operation. */
export function createDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid Postgres URL.");
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2
  ) {
    throw new Error("DATABASE_URL must name a Postgres host and database.");
  }

  const client = new SQL(databaseUrl, { bigint: true });
  return {
    db: drizzle({ client, schema }),
    close: () => client.close(),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];

const probeTimeoutSeconds = 2;

/**
 * Reports whether the database answers, over a fresh connection that is closed afterwards.
 * Never throws: readiness turns a lost database into a 503, not a dropped response.
 */
export async function probeDatabase(databaseUrl: string): Promise<boolean> {
  const probe = new SQL(databaseUrl, {
    max: 1,
    connectionTimeout: probeTimeoutSeconds,
  });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}
