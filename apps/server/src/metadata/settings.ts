import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { settings } from "../db/schema/index.ts";

const metadataSettingsKey = "metadata";

export interface MetadataSettings {
  providerOrder: string[];
  confidenceThreshold: number;
  libraries: Record<string, string[]>;
  tmdb: { apiKey: string } | null;
}

function invalid(): never {
  throw new Error("Invalid metadata settings.");
}

function providerIds(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) invalid();
    return entry.trim();
  });
  if (new Set(ids).size !== ids.length) invalid();
  return ids;
}

function readTmdb(value: unknown): { apiKey: string } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (typeof raw.apiKey !== "string" || raw.apiKey.trim().length === 0)
    invalid();
  return { ...raw, apiKey: raw.apiKey.trim() };
}

/** Reads metadata settings and applies documented defaults. */
export async function readMetadataSettings(
  db: Database,
): Promise<MetadataSettings> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, metadataSettingsKey))
    .limit(1);
  const raw: unknown = row === undefined ? {} : row.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const config = raw as Record<string, unknown>;

  const providerOrder =
    config.providerOrder === undefined
      ? ["tmdb"]
      : providerIds(config.providerOrder);

  const confidenceThreshold =
    config.confidenceThreshold === undefined ? 0.9 : config.confidenceThreshold;
  if (
    typeof confidenceThreshold !== "number" ||
    !Number.isFinite(confidenceThreshold) ||
    confidenceThreshold < 0 ||
    confidenceThreshold > 1
  )
    invalid();

  const librariesValue = config.libraries === undefined ? {} : config.libraries;
  if (
    librariesValue === null ||
    typeof librariesValue !== "object" ||
    Array.isArray(librariesValue)
  )
    invalid();
  const enabled = new Set(providerOrder);
  const libraries: Record<string, string[]> = {};
  for (const [libraryId, providers] of Object.entries(librariesValue)) {
    const ids = providerIds(providers);
    if (ids.some((id) => !enabled.has(id))) invalid();
    libraries[libraryId] = ids;
  }

  const tmdb = readTmdb(config.tmdb);

  return { ...config, providerOrder, confidenceThreshold, libraries, tmdb };
}

/** Returns enabled providers for a library in configured order. */
export function providersForLibrary(
  config: MetadataSettings,
  libraryId: string,
): string[] {
  const enabled = config.libraries[libraryId];
  if (enabled === undefined) return [...config.providerOrder];
  const allowed = new Set(enabled);
  return config.providerOrder.filter((id) => allowed.has(id));
}
