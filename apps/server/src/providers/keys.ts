import { eq, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { settings } from "../db/schema/index.ts";

const providersKey = "providers";
const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const maxValueLength = 4096;

function storedKeys(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Corrupt provider keys settings row.");
  const keys = (value as Record<string, unknown>).keys;
  if (keys === null || typeof keys !== "object" || Array.isArray(keys))
    throw new Error("Corrupt provider keys settings row.");
  for (const secret of Object.values(keys))
    if (typeof secret !== "string")
      throw new Error("Corrupt provider keys settings row.");
  return keys as Record<string, string>;
}

function normalizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!namePattern.test(normalized)) throw new AuthError("INVALID_INPUT");
  return normalized;
}

async function writeKeys(
  db: Database,
  update: (keys: Record<string, string>) => void,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, providersKey))
      .limit(1);
    const keys = storedKeys(row?.value);
    update(keys);
    const value: JsonObject = { keys };
    await tx
      .insert(settings)
      .values({
        key: providersKey,
        value,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: sql`clock_timestamp()` },
      });
    return Object.keys(keys).sort();
  });
}

/** Lists configured provider key names for a caller holding manage-server; values never leave the server. */
export async function listProviderKeys(db: Database, actorId: string) {
  await requirePermission(db, actorId, "manage-server");
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, providersKey))
    .limit(1);
  return Object.keys(storedKeys(row?.value)).sort();
}

/** Stores one provider key for a caller holding manage-server and returns the sorted names. */
export async function setProviderKey(
  db: Database,
  actorId: string,
  name: string,
  value: string,
) {
  await requirePermission(db, actorId, "manage-server");
  const key = normalizeName(name);
  if (value.length < 1 || value.length > maxValueLength || value.includes("\0"))
    throw new AuthError("INVALID_INPUT");
  return writeKeys(db, (keys) => {
    keys[key] = value;
  });
}

/** Removes one provider key for a caller holding manage-server and returns the sorted names. */
export async function removeProviderKey(
  db: Database,
  actorId: string,
  name: string,
) {
  await requirePermission(db, actorId, "manage-server");
  const key = normalizeName(name);
  return writeKeys(db, (keys) => {
    if (!(key in keys)) throw new AuthError("NOT_FOUND");
    delete keys[key];
  });
}
