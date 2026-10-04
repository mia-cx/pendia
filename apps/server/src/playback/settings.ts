import { eq, sql } from "drizzle-orm";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { settings } from "../db/schema/index.ts";

const playbackSettingsKey = "playback";

/** Reads the global default bitrate cap in bits per second; null when uncapped. */
export async function readGlobalBitrateCap(
  db: Database,
): Promise<number | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, playbackSettingsKey))
    .limit(1);
  if (row === undefined) return null;
  const raw: unknown = row.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid playback settings.");
  const cap = (raw as Record<string, unknown>).bitrateCapBps;
  if (cap === null || cap === undefined) return null;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)
    throw new Error("Invalid playback settings.");
  return cap;
}

/** Sets or clears the global default bitrate cap for a caller holding manage-server; the next plan reads it. */
export async function writeGlobalBitrateCap(
  db: Database,
  actorId: string,
  bitrateCapBps: number | null,
) {
  await requirePermission(db, actorId, "manage-server");
  // The row holds only the cap, so a write replaces it whole.
  const value = { bitrateCapBps };
  await db
    .insert(settings)
    .values({ key: playbackSettingsKey, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: sql`clock_timestamp()` },
    });
}
