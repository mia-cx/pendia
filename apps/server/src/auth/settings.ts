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

  const oidc = readOidc(config.oidc);

  return {
    sessionMaxAgeSeconds,
    loginMaxAttempts,
    loginWindowSeconds,
    trustedProxyAddresses,
    oidc,
  };
}
