import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { settings, settingsLockClass } from "../db/schema/index.ts";
import { AuthError } from "./errors.ts";
import { requirePermission } from "./permissions.ts";
import { normalizeAddress } from "./transport.ts";

const authSettingsKey = "auth";
const maxSeconds = 315_360_000;
const maxProxyAddresses = 64;

function invalid(): never {
  throw new Error("Invalid auth settings.");
}

function positiveInteger(
  value: unknown,
  fallback: number,
  cap: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > cap
  )
    invalid();
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid();
  return value.trim();
}

const scopePattern = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function readOidc(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  let issuer: URL;
  try {
    issuer = new URL(requiredString(raw.issuer));
  } catch {
    invalid();
  }
  const secure =
    issuer.protocol === "https:" ||
    (issuer.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(issuer.hostname));
  if (
    !secure ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  )
    invalid();
  if (!Array.isArray(raw.scopes)) invalid();
  const scopes = [...new Set(raw.scopes.map(requiredString))];
  if (
    !scopes.length ||
    !scopes.includes("openid") ||
    scopes.some((scope) => !scopePattern.test(scope))
  )
    invalid();
  return {
    issuer,
    clientId: requiredString(raw.clientId),
    clientSecret: requiredString(raw.clientSecret),
    scopes,
  };
}

function parseAuthSettings(raw: unknown) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const config = raw as Record<string, unknown>;

  const sessionMaxAgeSeconds =
    config.sessionMaxAgeSeconds == null
      ? null
      : positiveInteger(config.sessionMaxAgeSeconds, 0, maxSeconds);

  const loginMaxAttempts = positiveInteger(
    config.loginMaxAttempts,
    5,
    Number.MAX_SAFE_INTEGER,
  );
  const loginWindowSeconds = positiveInteger(
    config.loginWindowSeconds,
    900,
    maxSeconds,
  );

  const proxies =
    config.trustedProxyAddresses === undefined
      ? []
      : config.trustedProxyAddresses;
  if (!Array.isArray(proxies)) invalid();
  const trustedProxyAddresses = proxies.map((value) => {
    const normalized =
      typeof value === "string" ? normalizeAddress(value) : undefined;
    if (normalized === undefined) invalid();
    return normalized;
  });

  if (
    config.artworkRequiresAuth !== undefined &&
    typeof config.artworkRequiresAuth !== "boolean"
  )
    invalid();
  const artworkRequiresAuth = config.artworkRequiresAuth ?? false;

  const oidc = readOidc(config.oidc);

  return {
    sessionMaxAgeSeconds,
    loginMaxAttempts,
    loginWindowSeconds,
    trustedProxyAddresses,
    artworkRequiresAuth,
    oidc,
  };
}

/** Reads live auth configuration from settings, applying documented defaults. */
export async function readAuthSettings(db: Pick<Database, "select">) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, authSettingsKey))
    .limit(1);
  return parseAuthSettings(row === undefined ? {} : row.value);
}

/** The auth settings an admin may write in this slice. */
export type AuthSettingsPatch = {
  trustedProxyAddresses?: readonly string[];
  artworkRequiresAuth?: boolean;
};

function validatedPatch(patch: AuthSettingsPatch): JsonObject {
  const values: JsonObject = {};
  if (patch.trustedProxyAddresses !== undefined) {
    if (
      !Array.isArray(patch.trustedProxyAddresses) ||
      patch.trustedProxyAddresses.length > maxProxyAddresses
    )
      throw new AuthError("INVALID_INPUT");
    const addresses: string[] = [];
    for (const value of patch.trustedProxyAddresses) {
      const normalized =
        typeof value === "string" ? normalizeAddress(value) : undefined;
      if (normalized === undefined) throw new AuthError("INVALID_INPUT");
      addresses.push(normalized);
    }
    values.trustedProxyAddresses = [...new Set(addresses)];
  }
  if (patch.artworkRequiresAuth !== undefined) {
    if (typeof patch.artworkRequiresAuth !== "boolean")
      throw new AuthError("INVALID_INPUT");
    values.artworkRequiresAuth = patch.artworkRequiresAuth;
  }
  return values;
}

/** Merges a validated patch into the stored auth settings for a caller holding manage-server. */
export async function writeAuthSettings(
  db: Database,
  actorId: string,
  patch: AuthSettingsPatch,
) {
  await requirePermission(db, actorId, "manage-server");
  const values = validatedPatch(patch);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${settingsLockClass}, hashtext(${authSettingsKey}))`,
    );
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, authSettingsKey))
      .limit(1);
    const stored = row?.value;
    if (
      stored !== undefined &&
      (stored === null || typeof stored !== "object" || Array.isArray(stored))
    )
      invalid();
    // The raw stored object is written back untouched outside the patched
    // keys, so the OIDC issuer stays a string and never becomes a URL.
    const merged: JsonObject = { ...(stored ?? {}), ...values };
    const parsed = parseAuthSettings(merged);
    await tx
      .insert(settings)
      .values({
        key: authSettingsKey,
        value: merged,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: merged, updatedAt: sql`clock_timestamp()` },
      });
    return parsed;
  });
}
