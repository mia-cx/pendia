import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { settings } from "../db/schema/index.ts";
import { normalizeAddress } from "./transport.ts";

const authSettingsKey = "auth";
const maxSeconds = 315_360_000;

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

/** Reads live auth configuration from settings, applying documented defaults. */
export async function readAuthSettings(db: Database) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, authSettingsKey))
    .limit(1);
  const raw: unknown = row === undefined ? {} : row.value;
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

  return {
    sessionMaxAgeSeconds,
    loginMaxAttempts,
    loginWindowSeconds,
    trustedProxyAddresses,
  };
}
