import { createHash } from "node:crypto";
import { and, inArray, like, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { JsonValue } from "../db/schema/common.ts";
import { settings } from "../db/schema/index.ts";
import { AuthError } from "./errors.ts";
import type { readAuthSettings } from "./settings.ts";
import { normalizeAddress } from "./transport.ts";

const rateLimitLockKey = 0x70656e646172n;
const counterPrefix = "auth.login.";

type LoginLimitConfig = Pick<
  Awaited<ReturnType<typeof readAuthSettings>>,
  "loginMaxAttempts" | "loginWindowSeconds"
>;

type Counter = { attempts: number; expiresAt: number };

function readCounter(value: JsonValue): Counter {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  )
    throw new Error("Corrupt login attempt counter.");
  return { attempts: value.attempts, expiresAt: value.expiresAt };
}

/** Consumes one shared login attempt window for the address and account pair. */
export async function consumeLoginAttempt(
  db: Database,
  address: string,
  username: string,
  config: LoginLimitConfig,
): Promise<void> {
  const normalizedAddress = normalizeAddress(address);
  if (normalizedAddress === undefined) throw new AuthError("INVALID_INPUT");
  const account = username.trim().toLowerCase();
  const keys = [
    `auth.login.address.${createHash("sha256").update(normalizedAddress).digest("hex")}`,
    `auth.login.account.${createHash("sha256").update(account).digest("hex")}`,
  ];

  let retryAfterSeconds = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${rateLimitLockKey})`);
    const [nowRow] = await tx.execute<{ now: Date }>(
      sql`select clock_timestamp() as now`,
    );
    if (!nowRow) throw new Error("Database clock missing.");
    const nowMs = new Date(nowRow.now).getTime();

    await tx
      .delete(settings)
      .where(
        and(
          like(settings.key, `${counterPrefix}%`),
          sql`(${settings.value}->>'expiresAt')::double precision <= ${nowMs}`,
        ),
      );

    const rows = await tx
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, keys));
    const fresh = (): Counter => ({
      attempts: 0,
      expiresAt: nowMs + config.loginWindowSeconds * 1000,
    });
    const counters = keys.map((key) => {
      const row = rows.find((r) => r.key === key);
      if (!row) return fresh();
      const counter = readCounter(row.value);
      return counter.expiresAt <= nowMs ? fresh() : counter;
    });

    const blocking = counters.filter(
      (c) => c.attempts >= config.loginMaxAttempts,
    );
    if (blocking.length) {
      retryAfterSeconds = Math.max(
        ...blocking.map((c) => Math.ceil((c.expiresAt - nowMs) / 1000)),
        1,
      );
      return;
    }

    for (const [index, key] of keys.entries()) {
      const counter = counters[index];
      if (!counter) throw new Error("Counter bookkeeping broken.");
      const next: Counter = {
        attempts: counter.attempts + 1,
        expiresAt: counter.expiresAt,
      };
      const value = sql`jsonb_build_object('attempts', ${next.attempts}::bigint, 'expiresAt', ${next.expiresAt}::double precision)`;
      await tx
        .insert(settings)
        .values({
          key,
          value,
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: sql`clock_timestamp()` },
        });
    }
  });
  if (retryAfterSeconds > 0)
    throw new AuthError("RATE_LIMITED", retryAfterSeconds);
}
