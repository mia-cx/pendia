import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { migrateDatabase } from "../db/migrate.ts";
import { invites, settings, users } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { setupAdmin } from "./accounts.ts";
import { createAuthHandler } from "./http.ts";
import { createApiKey } from "./sessions.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe.skipIf(!databaseUrl)("auth http", () => {
  test("setup once across two servers, then login/me/logout over HTTP", () =>
    withDatabase(async (db, url) => {
      const first = await startPendia("api", { databaseUrl: url, port: 0 });
      const second = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base1 = `http://127.0.0.1:${first.apiServer?.port}`;
        const base2 = `http://127.0.0.1:${second.apiServer?.port}`;
        const setups = await Promise.all([
          post(`${base1}/api/auth/setup`, {
            username: "one",
            password: "first-pass",
          }),
          post(`${base2}/api/auth/setup`, {
            username: "two",
            password: "second-pass",
          }),
        ]);
        expect(setups.map((r) => r.status).sort()).toEqual([201, 409]);
        const winnerIndex = setups[0]?.status === 201 ? 0 : 1;
        const winner = setups[winnerIndex];
        if (!winner) throw new Error("Setup winner missing.");
        const winnerBody = (await winner.json()) as {
          user: { username: string };
        };
        expect(Object.keys(winnerBody)).toEqual(["user"]);
        expect(winner.headers.get("set-cookie")).toBeNull();
        expect(winner.headers.get("cache-control")).toBe("no-store");
        const loser = setups[1 - winnerIndex];
        if (!loser) throw new Error("Setup loser missing.");
        const loserBody = (await loser.json()) as {
          error: { code: string };
        };
        expect(loserBody.error.code).toBe("SETUP_COMPLETE");
        expect(await db.select().from(users)).toHaveLength(1);

        const login = await post(`${base1}/api/auth/login`, {
          username: winnerBody.user.username,
          password: winnerIndex === 0 ? "first-pass" : "second-pass",
          ...device,
        });
        expect(login.status).toBe(200);
        const loginBody = (await login.json()) as {
          token: string;
          user: { username: string };
          session: { clientName: string; deviceId: string };
        };
        expect(loginBody.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(loginBody.session).toMatchObject({
          clientName: "Test Client",
          deviceId: "device-1",
        });
        expect(login.headers.get("cache-control")).toBe("no-store");
        const cookie = login.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("pendia_session=");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).not.toContain("Secure");

        const bearer = await fetch(`${base1}/api/auth/me`, {
          headers: { authorization: `Bearer ${loginBody.token}` },
        });
        expect(bearer.status).toBe(200);
        const me = (await bearer.json()) as {
          user: { username: string };
          credential: { kind: string };
        };
        expect(me.credential.kind).toBe("session");
        const viaCookie = await fetch(`${base1}/api/auth/me`, {
          headers: { cookie: `pendia_session=${loginBody.token}` },
        });
        expect(viaCookie.status).toBe(200);

        const other = await post(`${base1}/api/auth/login`, {
          username: winnerBody.user.username,
          password: winnerIndex === 0 ? "first-pass" : "second-pass",
          ...device,
          deviceId: "device-2",
        });
        const otherToken = ((await other.json()) as { token: string }).token;

        const logout = await post(
          `${base1}/api/auth/logout`,
          {},
          {
            cookie: `pendia_session=${loginBody.token}`,
          },
        );
        expect(logout.status).toBe(200);
        expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
        const after = await fetch(`${base1}/api/auth/me`, {
          headers: { cookie: `pendia_session=${loginBody.token}` },
        });
        expect(after.status).toBe(401);
        expect(
          (
            (await (
              await fetch(`${base1}/api/auth/me`, {
                headers: { authorization: `Bearer ${otherToken}` },
              })
            ).json()) as { credential: { kind: string } }
          ).credential.kind,
        ).toBe("session");
      } finally {
        await first.stop();
        await second.stop();
      }
    }));

  test("rate limit applies to the real peer and ignores spoofed headers", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await setupAdmin(db, { username: "admin", password: "secret" });
      await db.insert(settings).values({
        key: "auth",
        value: sql`jsonb_build_object('loginMaxAttempts', 2)`,
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const spoofed = {
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-proto": "https",
        };
        for (const username of ["admin", "ghost"]) {
          const response = await post(
            `${base}/api/auth/login`,
            { username, password: "wrong", ...device },
            spoofed,
          );
          expect(response.status).toBe(401);
        }
        const limited = await post(
          `${base}/api/auth/login`,
          { username: "other", password: "wrong", ...device },
          spoofed,
        );
        expect(limited.status).toBe(429);
        expect(
          ((await limited.json()) as { error: { code: string } }).error.code,
        ).toBe("RATE_LIMITED");
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      } finally {
        await server.stop();
      }
    }));

  test("trusted proxy supplies secure cookie semantics", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await setupAdmin(db, { username: "admin", password: "secret" });
      await db.insert(settings).values({
        key: "auth",
        value: sql`jsonb_build_object('trustedProxyAddresses', jsonb_build_array('10.0.0.2'))`,
      });
      const handler = createAuthHandler(db);
      const body = JSON.stringify({
        username: "admin",
        password: "secret",
        ...device,
      });
      const init = (url: string, headers: Record<string, string>) =>
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        });

      const trusted = await handler(
        init("http://pendia.local/api/auth/login", {
          "x-forwarded-proto": "https",
          origin: "https://pendia.local",
        }),
        "10.0.0.2",
      );
      expect(trusted.status).toBe(200);
      expect(trusted.headers.get("set-cookie")).toContain("Secure");

      const untrusted = await handler(
        init("http://pendia.local/api/auth/login", {
          "x-forwarded-proto": "https",
          origin: "http://pendia.local",
        }),
        "10.0.0.9",
      );
      expect(untrusted.status).toBe(200);
      expect(untrusted.headers.get("set-cookie")).not.toContain("Secure");

      const direct = await handler(
        init("https://pendia.local/api/auth/login", {
          origin: "https://pendia.local",
        }),
        "10.0.0.9",
      );
      expect(direct.status).toBe(200);
      expect(direct.headers.get("set-cookie")).toContain("Secure");
    }));

  test("rejects malformed input, methods, unknown paths and spoofed tokens", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await setupAdmin(db, { username: "admin", password: "secret" });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const loginUrl = `${base}/api/auth/login`;
        const cases: [Response, number, string][] = [];
        cases.push([await post(loginUrl, "{bad json"), 400, "INVALID_INPUT"]);
        cases.push([await post(loginUrl, "[]"), 400, "INVALID_INPUT"]);
        cases.push([
          await post(loginUrl, { username: 5 }),
          400,
          "INVALID_INPUT",
        ]);
        cases.push([
          await fetch(loginUrl, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          }),
          400,
          "INVALID_INPUT",
        ]);
        cases.push([
          await post(loginUrl, "x".repeat(17_000)),
          413,
          "BODY_TOO_LARGE",
        ]);
        for (const [response, status, code] of cases) {
          expect(response.status).toBe(status);
          expect(
            ((await response.json()) as { error: { code: string } }).error.code,
          ).toBe(code);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("x-content-type-options")).toBe(
            "nosniff",
          );
        }

        const wrongMethod = await fetch(loginUrl, { method: "GET" });
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers.get("allow")).toBe("POST");
        expect((await fetch(`${base}/api/auth/nope`)).status).toBe(404);
        expect(
          (await fetch(`${base}/api/auth/me?token=${"a".repeat(43)}`)).status,
        ).toBe(401);

        const good = await post(loginUrl, {
          username: "admin",
          password: "secret",
          ...device,
        });
        const token = ((await good.json()) as { token: string }).token;
        const badAuth = await fetch(`${base}/api/auth/me`, {
          headers: {
            authorization: "Bearer garbage",
            cookie: `pendia_session=${token}`,
          },
        });
        expect(badAuth.status).toBe(401);

        const crossSite = await post(
          loginUrl,
          { username: "admin", password: "secret", ...device },
          { origin: "https://evil.example" },
        );
        expect(crossSite.status).toBe(403);
        const fetchSite = await post(
          loginUrl,
          { username: "admin", password: "secret", ...device },
          { "sec-fetch-site": "cross-site" },
        );
        expect(fetchSite.status).toBe(403);
        const sameOrigin = await post(
          loginUrl,
          { username: "admin", password: "secret", ...device },
          { origin: `http://127.0.0.1:${server.apiServer?.port}` },
        );
        expect(sameOrigin.status).toBe(200);
      } finally {
        await server.stop();
      }
    }));

  test("invites create and accept local accounts over HTTP", () =>
    withDatabase(async (db, url) => {
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const setup = await post(`${base}/api/auth/setup`, {
          username: "admin",
          password: "secret",
        });
        expect(setup.status).toBe(201);
        const loginResponse = await post(`${base}/api/auth/login`, {
          username: "admin",
          password: "secret",
          ...device,
        });
        const adminToken = ((await loginResponse.json()) as { token: string })
          .token;
        const invited = { authorization: `Bearer ${adminToken}` };

        const anonymous = await post(`${base}/api/auth/invites`, {
          email: "a@b.co",
          expiresInSeconds: 600,
        });
        expect(anonymous.status).toBe(401);
        expect(
          ((await anonymous.json()) as { error: { code: string } }).error.code,
        ).toBe("UNAUTHENTICATED");
        const malformed = await post(
          `${base}/api/auth/invites`,
          { email: "a@b.co", expiresInSeconds: "600" },
          invited,
        );
        expect(malformed.status).toBe(400);
        expect(
          ((await malformed.json()) as { error: { code: string } }).error.code,
        ).toBe("INVALID_INPUT");

        const created = await post(
          `${base}/api/auth/invites`,
          { email: " Invitee@Example.COM ", expiresInSeconds: 600 },
          invited,
        );
        expect(created.status).toBe(201);
        const createdBody = (await created.json()) as {
          token: string;
          invite: { id: string; email: string; acceptedAt: string | null };
        };
        expect(createdBody.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Object.keys(createdBody.invite).sort()).toEqual([
          "acceptedAt",
          "email",
          "expiresAt",
          "id",
          "invitedBy",
        ]);
        expect(createdBody.invite.email).toBe("invitee@example.com");
        expect(createdBody.invite.acceptedAt).toBeNull();
        expect(JSON.stringify(createdBody.invite)).not.toContain(
          createdBody.token,
        );

        const accepted = await post(`${base}/api/auth/invites/accept`, {
          token: createdBody.token,
          username: "newbie",
          password: "newbie-pass",
          displayName: "New Bee",
          ...device,
        });
        expect(accepted.status).toBe(201);
        const acceptedBody = (await accepted.json()) as {
          token: string;
          user: { username: string; displayName: string };
          session: {
            clientName: string;
            deviceId: string;
            deviceName: string;
          };
        };
        expect(acceptedBody.user).toMatchObject({
          username: "newbie",
          displayName: "New Bee",
        });
        expect(acceptedBody.session).toMatchObject(device);
        const cookie = accepted.headers.get("set-cookie") ?? "";
        expect(cookie).toContain(`pendia_session=${acceptedBody.token}`);
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).toContain("Path=/");
        expect(cookie).toContain("Max-Age=");
        const me = await fetch(`${base}/api/auth/me`, {
          headers: { authorization: `Bearer ${acceptedBody.token}` },
        });
        expect(me.status).toBe(200);

        const replay = await post(`${base}/api/auth/invites/accept`, {
          token: createdBody.token,
          username: "second",
          password: "pass",
          ...device,
        });
        expect(replay.status).toBe(400);
        expect(
          ((await replay.json()) as { error: { code: string } }).error.code,
        ).toBe("INVALID_INVITE");

        const second = await post(
          `${base}/api/auth/invites`,
          { email: "late@example.com", expiresInSeconds: 600 },
          invited,
        );
        const secondBody = (await second.json()) as {
          token: string;
          invite: { id: string };
        };
        await db
          .update(invites)
          .set({ expiresAt: sql`statement_timestamp() - interval '1 second'` })
          .where(eq(invites.id, secondBody.invite.id));
        const expired = await post(`${base}/api/auth/invites/accept`, {
          token: secondBody.token,
          username: "late",
          password: "pass",
          ...device,
        });
        expect(expired.status).toBe(400);
        expect(
          ((await expired.json()) as { error: { code: string } }).error.code,
        ).toBe("INVALID_INVITE");
      } finally {
        await server.stop();
      }
    }));

  test("API keys authenticate at me and logout revokes only the key", () =>
    withDatabase(async (db, url) => {
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const setup = await post(`${base}/api/auth/setup`, {
          username: "admin",
          password: "secret",
        });
        expect(setup.status).toBe(201);
        const admin = ((await setup.json()) as { user: { id: string } }).user;
        const { token } = await createApiKey(db, admin.id, "bot");
        const me = await fetch(`${base}/api/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(me.status).toBe(200);
        expect(
          ((await me.json()) as { credential: { kind: string } }).credential
            .kind,
        ).toBe("api-key");
        const logout = await post(
          `${base}/api/auth/logout`,
          {},
          { authorization: `Bearer ${token}` },
        );
        expect(logout.status).toBe(200);
        const after = await fetch(`${base}/api/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(after.status).toBe(401);
      } finally {
        await server.stop();
      }
    }));
});
