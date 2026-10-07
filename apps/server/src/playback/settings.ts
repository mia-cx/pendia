import { eq, sql } from "drizzle-orm";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { settings } from "../db/schema/index.ts";

const playbackSettingsKey = "playback";

/** Reads the live playback defaults; CPU 4K encoding requires an explicit opt-in. */
export async function readPlaybackSettings(db: Database) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, playbackSettingsKey))
    .limit(1);
  if (row === undefined) return { bitrateCapBps: null, allowCpu4k: false };
  const raw: unknown = row.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid playback settings.");
  const cap = (raw as Record<string, unknown>).bitrateCapBps;
  const allowCpu4k = (raw as Record<string, unknown>).allowCpu4k ?? false;
  if (
    (cap != null &&
      (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)) ||
    typeof allowCpu4k !== "boolean"
  )
    throw new Error("Invalid playback settings.");
  return { bitrateCapBps: cap ?? null, allowCpu4k };
}

/** Patches live playback defaults for a caller holding manage-server; the next plan reads them. */
export async function writePlaybackSettings(
  db: Database,
  actorId: string,
  patch: { bitrateCapBps?: number | null; allowCpu4k?: boolean },
) {
  await requirePermission(db, actorId, "manage-server");
  await db
    .insert(settings)
    .values({ key: playbackSettingsKey, value: patch })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`${settings.value} || ${JSON.stringify(patch)}::text::jsonb`,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

/** Sets or clears the global bitrate cap without changing the CPU 4K opt-in. */
export async function writeGlobalBitrateCap(
  db: Database,
  actorId: string,
  bitrateCapBps: number | null,
) {
  await writePlaybackSettings(db, actorId, { bitrateCapBps });
}
