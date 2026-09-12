import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { sessions, settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { setupAdmin } from "./accounts.ts";
import { consumeLoginAttempt } from "./rate-limit.ts";
import { authenticate, login } from "./sessions.ts";
import { readAuthSettings } from "./settings.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const limit = { loginMaxAttempts: 2, loginWindowSeconds: 900 };

describe.skipIf(!databaseUrl)("auth settings and rate limits", () => {
  test("settings apply defaults, live updates and reject malformed config", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      expect(await readAuthSettings(db)).toEqual({
        sessionMaxAgeSeconds: null,
        loginMaxAttempts: 5,
        loginWindowSeconds: 900,
        trustedProxyAddresses: [],
        oidc: null,
      });
      await db.insert(settings).values({
        key: "auth",
        value: sql`jsonb_build_object('loginMaxAttempts', 7, 'trustedProxyAddresses', jsonb_build_array('10.0.0.2', '::FFFF:10.0.0.3'), 'unknownKey', true)`,
      });
      expect(await readAuthSettings(db)).toEqual({
        sessionMaxAgeSeconds: null,
        loginMaxAttempts: 7,
        loginWindowSeconds: 900,
        trustedProxyAddresses: ["10.0.0.2", "10.0.0.3"],
        oidc: null,
      });
      for (const value of [
        sql`'[]'::jsonb`,
        sql`'"oops"'::jsonb`,
        sql`jsonb_build_object('loginMaxAttempts', 0)`,
        sql`jsonb_build_object('loginWindowSeconds', -5)`,
        sql`jsonb_build_object('sessionMaxAgeSeconds', 400000000)`,
        sql`jsonb_build_object('trustedProxyAddresses', jsonb_build_array('not-an-ip'))`,
      ]) {
        await db
          .update(settings)
          .set({ value })
          .where(eq(settings.key, "auth"));
        await expect(readAuthSettings(db)).rejects.toThrow(
          "Invalid auth settings.",
        );
      }
    }));

  test("session max age binds live without revoking on reset", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await setupAdmin(db, { username: "admin", password: "secret" });
      const { token } = await login(
        db,
        { username: "admin", password: "secret", ...device },
        "192.0.2.1",
      );
      expect((await authenticate(db, token)).user.username).toBe("admin");
      await db
        .update(sessions)
        .set({ createdAt: sql`statement_timestamp() - interval '2 hours'` });
      await db.insert(settings).values({
        key: "auth",
        value: sql`jsonb_build_object('sessionMaxAgeSeconds', 3600)`,
      });
      await expect(authenticate(db, token)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      await db
        .update(settings)
        .set({ value: sql`jsonb_build_object('sessionMaxAgeSeconds', null)` })
        .where(eq(settings.key, "auth"));
      expect((await authenticate(db, token)).credential.kind).toBe("session");
    }));

  test("shared windows block by address and normalized account", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await consumeLoginAttempt(db, "192.0.2.10", "alice", limit);
      await consumeLoginAttempt(db, "192.0.2.10", "alice", limit);
      await expect(
        consumeLoginAttempt(db, "192.0.2.10", "alice", limit),
      ).rejects.toMatchObject({
        code: "RATE_LIMITED",
        retryAfterSeconds: expect.any(Number),
      });
      await expect(
        consumeLoginAttempt(db, "192.0.2.10", "bob", limit),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      await expect(
        consumeLoginAttempt(db, "198.51.100.9", " ALICE ", limit),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      await consumeLoginAttempt(db, "198.51.100.9", "carol", limit);
      await expect(
        consumeLoginAttempt(db, "not-an-ip", "carol", limit),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }));

  test("retryAfter comes only from the counters actually blocking", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const blockingWindowSeconds = 300;
      const config = { loginMaxAttempts: 1, loginWindowSeconds: 900 };
      await consumeLoginAttempt(db, "192.0.2.50", "frank", config);
      const key = `auth.login.account.${createHash("sha256").update("frank").digest("hex")}`;
      await db.execute(
        sql`update settings set value = jsonb_build_object('attempts', (value->>'attempts')::integer, 'expiresAt', extract(epoch from clock_timestamp()) * 1000 + ${blockingWindowSeconds} * 1000) where key = ${key}`,
      );
      const blocked = await consumeLoginAttempt(
        db,
        "198.51.100.7",
        "frank",
        config,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(blocked).toMatchObject({ code: "RATE_LIMITED" });
      const retry = (blocked as { retryAfterSeconds?: number })
        .retryAfterSeconds;
      expect(retry).toBeGreaterThanOrEqual(1);
      // Five minutes tolerates loaded CI but stays below the fresh,
      // nonblocking address counter's fifteen-minute window.
      expect(retry).toBeLessThanOrEqual(blockingWindowSeconds);
    }));

  test("concurrent callers share the same fixed windows", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const second = createDatabase(url);
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, (_, i) =>
            consumeLoginAttempt(
              i % 2 ? second.db : db,
              "192.0.2.20",
              "dave",
              limit,
            ),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
        expect(
          results.filter(
            (r) => r.status === "rejected" && r.reason?.code === "RATE_LIMITED",
          ),
        ).toHaveLength(4);
      } finally {
        await second.close();
      }
    }));

  test("expired windows reset and blocked calls do not extend them", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const fast = { loginMaxAttempts: 1, loginWindowSeconds: 1 };
      await consumeLoginAttempt(db, "192.0.2.30", "erin", fast);
      await expect(
        consumeLoginAttempt(db, "192.0.2.30", "erin", fast),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      await Bun.sleep(1050);
      await consumeLoginAttempt(db, "192.0.2.30", "erin", fast);
    }));

  test("malformed device metadata rejects before consuming an attempt", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await setupAdmin(db, { username: "admin", password: "secret" });
      await db.insert(settings).values({
        key: "auth",
        value: sql`jsonb_build_object('loginMaxAttempts', 1, 'loginWindowSeconds', 900)`,
      });
      await expect(
        login(
          db,
          {
            username: "admin",
            password: "secret",
            clientName: " ",
            deviceId: "device-1",
            deviceName: "Living Room",
          },
          "192.0.2.60",
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const valid = await login(
        db,
        { username: "admin", password: "secret", ...device },
        "192.0.2.60",
      );
      expect(valid.user.username).toBe("admin");
    }));

  test(
    "login consumes the configured limit before password work",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await setupAdmin(db, { username: "admin", password: "secret" });
        await db.insert(settings).values({
          key: "auth",
          value: sql`jsonb_build_object('loginMaxAttempts', 2, 'loginWindowSeconds', 900)`,
        });
        const input = { username: "admin", password: "wrong", ...device };
        await expect(login(db, input, "192.0.2.40")).rejects.toMatchObject({
          code: "INVALID_CREDENTIALS",
        });
        await expect(login(db, input, "192.0.2.40")).rejects.toMatchObject({
          code: "INVALID_CREDENTIALS",
        });
        await expect(
          login(
            db,
            { username: "admin", password: "secret", ...device },
            "192.0.2.40",
          ),
        ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      }),
    15_000,
  );
});
