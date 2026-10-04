import type { Capability } from "@pendia/plugin-api";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { settings, settingsLockClass } from "../db/schema/index.ts";
import { PluginError } from "./errors.ts";
import { capabilities } from "./manifest.ts";

const pluginSettingsKey = "plugins";

/** The Postgres NOTIFY channel that tells every process the plugin settings or lockfile changed. */
export const pluginChannel = "pendia_plugins";

/** The registry Pendia ships with, where the first-party plugins live. */
export const officialRegistry = "https://github.com/mia-cx/pendia";

/** A files switch that is off: for good when `until` is null, otherwise until that instant. */
export type FilesOff = { until: string | null };

/** What an admin decided about one installed plugin. */
export type PluginState = {
  /** The capabilities approved at install: the manifest's at the installed integrity. */
  capabilities: Capability[];
  enabled: boolean;
  failure: { message: string; at: string } | null;
  filesOff: FilesOff | null;
  config: JsonObject;
};

/** The `plugins` settings row. */
export type PluginSettings = {
  filesOff: FilesOff | null;
  registries: string[];
  plugins: Record<string, PluginState>;
};

/** A plugin settings value the stored row cannot hold. */
export class InvalidPluginSettings extends Error {
  constructor() {
    super("Invalid plugin settings.");
    this.name = "InvalidPluginSettings";
  }
}

function invalid(): never {
  throw new InvalidPluginSettings();
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}

function readFilesOff(value: unknown): FilesOff | null {
  if (value === undefined || value === null) return null;
  const { until } = record(value);
  if (until === null) return { until: null };
  if (typeof until !== "string" || Number.isNaN(Date.parse(until))) invalid();
  return { until };
}

function readState(value: unknown): PluginState {
  const raw = record(value);
  if (!Array.isArray(raw.capabilities)) invalid();
  const approved = raw.capabilities.map(
    (entry: unknown) =>
      capabilities.find((capability) => capability === entry) ?? invalid(),
  );
  if (typeof raw.enabled !== "boolean") invalid();
  let failure: PluginState["failure"] = null;
  if (raw.failure !== undefined && raw.failure !== null) {
    const { message, at } = record(raw.failure);
    if (typeof message !== "string" || typeof at !== "string") invalid();
    failure = { message, at };
  }
  return {
    capabilities: approved,
    enabled: raw.enabled,
    failure,
    filesOff: readFilesOff(raw.filesOff),
    config: raw.config === undefined ? {} : (record(raw.config) as JsonObject),
  };
}

/** Parses a stored plugin settings value, applying the defaults. */
export function parsePluginSettings(value: unknown): PluginSettings {
  const raw = record(value);
  const registries = raw.registries ?? [officialRegistry];
  if (
    !Array.isArray(registries) ||
    !registries.every((url) => typeof url === "string")
  )
    invalid();
  return {
    filesOff: readFilesOff(raw.filesOff),
    registries,
    plugins: Object.fromEntries(
      Object.entries(record(raw.plugins ?? {})).map(([name, state]) => [
        name,
        readState(state),
      ]),
    ),
  };
}

/** Reads the plugin settings row with its defaults. */
export async function readPluginSettings(
  db: Pick<Database, "select">,
): Promise<PluginSettings> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, pluginSettingsKey))
    .limit(1);
  return parsePluginSettings(row === undefined ? {} : row.value);
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Rewrites the plugin settings under the settings lock and notifies every
 * process. `change` runs inside the transaction, so it may write related rows
 * such as the lockfile.
 */
export async function updatePluginSettings(
  db: Database,
  change: (
    current: PluginSettings,
    tx: Transaction,
  ) => PluginSettings | Promise<PluginSettings>,
): Promise<PluginSettings> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${settingsLockClass}, hashtext(${pluginSettingsKey}))`,
    );
    const next = await change(await readPluginSettings(tx), tx);
    const value: JsonObject = next;
    await tx
      .insert(settings)
      .values({
        key: pluginSettingsKey,
        value,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: sql`clock_timestamp()` },
      });
    await tx.execute(sql`select pg_notify(${pluginChannel}, '')`);
    return next;
  });
}

/** Rewrites one installed plugin's state. */
export async function updatePluginState(
  db: Database,
  name: string,
  change: (state: PluginState) => PluginState,
): Promise<PluginSettings> {
  return updatePluginSettings(db, (current) => {
    const state = current.plugins[name];
    if (state === undefined)
      throw new PluginError("NOT_FOUND", `${name} is not installed.`);
    return {
      ...current,
      plugins: { ...current.plugins, [name]: change(state) },
    };
  });
}

/** Reports whether a files switch is off at `now`. */
export function isFilesOff(off: FilesOff | null, now = new Date()): boolean {
  return (
    off !== null &&
    (off.until === null || Date.parse(off.until) > now.getTime())
  );
}
