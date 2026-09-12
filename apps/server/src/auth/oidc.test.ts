import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  groups,
  invites,
  sessions,
  settings,
  userGroups,
  users,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import { createInvite } from "./invites.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

type ProviderClaims = {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  name?: string;
};

const b64url = (data: string | Uint8Array) =>
  Buffer.from(data).toString("base64url");

const rsa = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

async function startProvider(
  claims: ProviderClaims,
  options: { omitUserInfo?: boolean; userInfo?: ProviderClaims } = {},
) {
  const signing = await crypto.subtle.generateKey(rsa, true, [
    "sign",
    "verify",
  ]);
  const rogue = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", signing.publicKey);
  const jwk = { ...exported, kid: "pendia-test", alg: "RS256", use: "sig" };
  const pending = new Map<
    string,
    {
      nonce: string;
      challenge: string;
      redirectUri: string;
      claims: { idToken: ProviderClaims; userInfo: ProviderClaims | null };
    }
  >();
  const tokens = new Map<string, ProviderClaims>();
  const provider = {
    claims: {
      idToken: claims,
      userInfo: options.userInfo ?? null,
    },
    rogueSign: false,
    observed: {
      discovery: 0,
      token: 0,
      jwks: 0,
      userinfo: 0,
      tokenClient: "",
      verifierOk: false,
      authorize: {} as Record<string, string | null>,
    },
    issuer: "",
  };
  const sign = async (payload: Record<string, unknown>) => {
    const header = b64url(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "pendia-test" }),
    );
    const body = b64url(JSON.stringify(payload));
    const key = provider.rogueSign ? rogue.privateKey : signing.privateKey;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(`${header}.${body}`),
    );
    return `${header}.${body}.${b64url(new Uint8Array(signature))}`;
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const issuer = provider.issuer;
      if (url.pathname === "/.well-known/openid-configuration") {
        provider.observed.discovery += 1;
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          ...(options.omitUserInfo
            ? {}
            : { userinfo_endpoint: `${issuer}/userinfo` }),
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          scopes_supported: ["openid", "profile", "email"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        provider.observed.authorize = {
          client_id: q.get("client_id"),
          redirect_uri: q.get("redirect_uri"),
          response_type: q.get("response_type"),
          scope: q.get("scope"),
          state: q.get("state"),
          nonce: q.get("nonce"),
          code_challenge: q.get("code_challenge"),
          code_challenge_method: q.get("code_challenge_method"),
        };
        const redirect = q.get("redirect_uri");
        const state = q.get("state");
        const nonce = q.get("nonce");
        const challenge = q.get("code_challenge");
        if (
          q.get("client_id") !== "pendia" ||
          redirect === null ||
          q.get("response_type") !== "code" ||
          !(q.get("scope") ?? "").split(" ").includes("openid") ||
          state === null ||
          nonce === null ||
          challenge === null ||
          q.get("code_challenge_method") !== "S256"
        )
          return json({ error: "invalid_request" }, 400);
        const code = randomBytes(16).toString("hex");
        pending.set(code, {
          nonce,
          challenge,
          redirectUri: redirect,
          claims: provider.claims,
        });
        const target = new URL(redirect);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        target.searchParams.set("iss", issuer);
        return new Response(null, {
          status: 302,
          headers: { Location: target.href },
        });
      }
      if (url.pathname === "/token") {
        provider.observed.token += 1;
        const authorization = request.headers.get("authorization") ?? "";
        provider.observed.tokenClient = authorization.startsWith("Basic ")
          ? Buffer.from(authorization.slice(6), "base64").toString()
          : "";
        if (provider.observed.tokenClient !== "pendia:secret")
          return json({ error: "invalid_client" }, 401);
        const params = new URLSearchParams(await request.text());
        const grant = pending.get(params.get("code") ?? "");
        if (
          params.get("grant_type") !== "authorization_code" ||
          grant === undefined
        )
          return json({ error: "invalid_grant" }, 400);
        pending.delete(params.get("code") ?? "");
        if (params.get("redirect_uri") !== grant.redirectUri)
          return json({ error: "invalid_grant" }, 400);
        const digest = createHash("sha256")
          .update(params.get("code_verifier") ?? "")
          .digest("base64url");
        if (digest !== grant.challenge)
          return json({ error: "invalid_grant" }, 400);
        provider.observed.verifierOk = true;
        const accessToken = randomBytes(24).toString("base64url");
        tokens.set(accessToken, grant.claims.userInfo ?? grant.claims.idToken);
        const current = grant.claims.idToken;
        const idToken = await sign({
          iss: issuer,
          sub: current.sub,
          aud: "pendia",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          nonce: grant.nonce,
          email: current.email,
          email_verified: current.emailVerified,
          preferred_username: current.preferredUsername,
          name: current.name,
        });
        return json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 600,
          id_token: idToken,
        });
      }
      if (url.pathname === "/jwks") {
        provider.observed.jwks += 1;
        return json({ keys: [jwk] });
      }
      if (url.pathname === "/userinfo") {
        provider.observed.userinfo += 1;
        const authorization = request.headers.get("authorization") ?? "";
        const served = tokens.get(authorization.replace(/^Bearer\s+/i, ""));
        if (!served) return json({ error: "invalid_token" }, 401);
        return json({
          sub: served.sub,
          email: served.email,
          email_verified: served.emailVerified,
          preferred_username: served.preferredUsername,
          name: served.name,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  provider.issuer = `http://127.0.0.1:${server.port}`;
  return {
    issuer: provider.issuer,
    observed: provider.observed,
    setClaims(next: ProviderClaims, userInfo: ProviderClaims | null = null) {
      provider.claims = { idToken: next, userInfo };
    },
    signWithRogue() {
      provider.rogueSign = true;
    },
    stop: () => server.stop(true),
  };
}

async function oidcLogin(
  base: string,
  options: { invite?: string; deviceId?: string } = {},
) {
  const params = new URLSearchParams({
    clientName: device.clientName,
    deviceId: options.deviceId ?? device.deviceId,
    deviceName: device.deviceName,
  });
  if (options.invite) params.set("invite", options.invite);
  const start = await fetch(`${base}/api/auth/oidc/login?${params}`, {
    redirect: "manual",
  });
  const location = start.headers.get("location");
  const flowCookie =
    (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const authorize = location
    ? await fetch(location, { redirect: "manual" })
    : undefined;
  const callbackUrl = authorize?.headers.get("location") ?? undefined;
  return { start, authorize, callbackUrl, flowCookie };
}

function oidcCallback(flow: { callbackUrl?: string; flowCookie: string }) {
  return fetch(flow.callbackUrl ?? "", {
    redirect: "manual",
    headers: { cookie: flow.flowCookie },
  });
}

async function configureOidc(
  db: Database,
  issuer: string,
  trustedProxyAddresses: string[] = [],
) {
  await db.insert(settings).values({
    key: "auth",
    value: {
      trustedProxyAddresses,
      oidc: {
        issuer,
        clientId: "pendia",
        clientSecret: "secret",
        scopes: ["openid", "profile", "email"],
      },
    },
  });
}

describe.skipIf(!databaseUrl)("auth oidc", () => {
  test("verified email links an existing account through the full round trip", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "subject-1",
        email: "LINKED@example.com",
        emailVerified: true,
        preferredUsername: "linked",
        name: "Linked User",
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const local = await createLocalUser(db, admin.id, {
          username: "linked",
          password: "pass",
        });
        await db
          .update(users)
          .set({ email: "linked@example.com" })
          .where(eq(users.id, local.id));

        const flow = await oidcLogin(base, { deviceId: " spaced-device " });
        const callback = await oidcCallback(flow);
        expect(flow.start.status).toBe(302);
        expect(flow.authorize?.status).toBe(302);
        expect(callback.status).toBe(200);
        const body = (await callback.json()) as {
          token: string;
          user: { id: string; username: string };
          session: {
            clientName: string;
            deviceId: string;
            deviceName: string;
          };
        };
        expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.user.id).toBe(local.id);
        expect(body.user.username).toBe("linked");
        expect(body.session).toMatchObject({
          clientName: device.clientName,
          deviceName: device.deviceName,
        });
        expect(body.session.deviceId).toBe(" spaced-device ");
        const cookies = callback.headers.getSetCookie();
        expect(
          cookies.some(
            (c) => c.startsWith("pendia_session=") && c.includes("HttpOnly"),
          ),
        ).toBe(true);
        expect(
          cookies.some(
            (c) =>
              c.startsWith("pendia_oidc_flow=;") && c.includes("Max-Age=0"),
          ),
        ).toBe(true);

        const [stored] = await db
          .select()
          .from(users)
          .where(eq(users.id, local.id));
        expect(stored?.oidcIssuer).toBe(new URL(provider.issuer).href);
        expect(stored?.oidcSubject).toBe("subject-1");

        expect(provider.observed.discovery).toBeGreaterThanOrEqual(2);
        expect(provider.observed.token).toBe(1);
        expect(provider.observed.jwks).toBeGreaterThanOrEqual(1);
        expect(provider.observed.userinfo).toBe(1);
        expect(provider.observed.tokenClient).toBe("pendia:secret");
        expect(provider.observed.verifierOk).toBe(true);
        const seen = provider.observed.authorize;
        expect(seen.client_id).toBe("pendia");
        expect(seen.response_type).toBe("code");
        expect(seen.scope).toBe("openid profile email");
        expect(seen.code_challenge_method).toBe("S256");
        expect(seen.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(seen.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(seen.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(seen.redirect_uri).toBe(`${base}/api/auth/oidc/callback`);

        const me = await fetch(`${base}/api/auth/me`, {
          headers: { authorization: `Bearer ${body.token}` },
        });
        expect(me.status).toBe(200);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("verified ID-token email links when UserInfo is not advertised", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider(
        {
          sub: "subject-8",
          email: "LINKED@example.com",
          emailVerified: true,
        },
        { omitUserInfo: true },
      );
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const local = await createLocalUser(db, admin.id, {
          username: "linked",
          password: "pass",
        });
        await db
          .update(users)
          .set({ email: "linked@example.com" })
          .where(eq(users.id, local.id));

        const callback = await oidcCallback(await oidcLogin(base));
        expect(callback.status).toBe(200);
        const body = (await callback.json()) as { user: { id: string } };
        expect(body.user.id).toBe(local.id);
        expect(provider.observed.userinfo).toBe(0);
        const [stored] = await db
          .select()
          .from(users)
          .where(eq(users.id, local.id));
        expect(stored?.oidcIssuer).toBe(new URL(provider.issuer).href);
        expect(stored?.oidcSubject).toBe("subject-8");
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("an exact issuer and subject link logs in without verified claims", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "subject-2",
        email: "linked@example.com",
        emailVerified: true,
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const local = await createLocalUser(db, admin.id, {
          username: "linked",
          password: "pass",
        });
        await db
          .update(users)
          .set({ email: "linked@example.com" })
          .where(eq(users.id, local.id));

        const first = await oidcCallback(await oidcLogin(base));
        expect(first.status).toBe(200);
        provider.setClaims({ sub: "subject-2", emailVerified: false });
        const second = await oidcCallback(await oidcLogin(base));
        expect(second.status).toBe(200);
        const body = (await second.json()) as {
          user: { id: string };
        };
        expect(body.user.id).toBe(local.id);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("a matching invite creates an OIDC-only member exactly once", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "invitee-sub",
        email: "invited@example.com",
        emailVerified: true,
        preferredUsername: "Invited Person",
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const { token: inviteToken, invite } = await createInvite(
          db,
          admin.id,
          { email: "Invited@Example.com", expiresInSeconds: 600 },
        );

        const callback = await oidcCallback(
          await oidcLogin(base, { invite: inviteToken }),
        );
        expect(callback.status).toBe(200);
        const body = (await callback.json()) as {
          token: string;
          user: { id: string; username: string; displayName: string };
        };
        expect(body.user.username).toBe("invited-person");
        expect(body.user.displayName).toBe("Invited Person");
        const [created] = await db
          .select()
          .from(users)
          .where(eq(users.id, body.user.id));
        expect(created?.email).toBe("invited@example.com");
        expect(created?.passwordHash).toBeNull();
        expect(created?.oidcIssuer).toBe(new URL(provider.issuer).href);
        expect(created?.oidcSubject).toBe("invitee-sub");
        const [membership] = await db
          .select({ name: groups.name })
          .from(userGroups)
          .innerJoin(groups, eq(groups.id, userGroups.groupId))
          .where(eq(userGroups.userId, body.user.id));
        expect(membership?.name).toBe("users");
        const [consumed] = await db
          .select({ acceptedAt: invites.acceptedAt })
          .from(invites)
          .where(eq(invites.id, invite.id));
        expect(consumed?.acceptedAt).not.toBeNull();
        const me = await fetch(`${base}/api/auth/me`, {
          headers: { authorization: `Bearer ${body.token}` },
        });
        expect(me.status).toBe(200);

        const userCount = (await db.select().from(users)).length;
        provider.setClaims({
          sub: "another-sub",
          email: "other@example.com",
          emailVerified: true,
        });
        const again = await oidcCallback(
          await oidcLogin(base, { invite: inviteToken }),
        );
        expect(again.status).toBe(400);
        expect(
          ((await again.json()) as { error: { code: string } }).error.code,
        ).toBe("INVALID_INVITE");
        expect(await db.select().from(users)).toHaveLength(userCount);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("an invite authorizes creation for an unverified email claim", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "pending-sub",
        email: "Pending@Example.com",
        emailVerified: false,
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const { token: inviteToken, invite } = await createInvite(
          db,
          admin.id,
          { email: "pending@example.com", expiresInSeconds: 600 },
        );

        const callback = await oidcCallback(
          await oidcLogin(base, { invite: inviteToken }),
        );
        expect(callback.status).toBe(200);
        const body = (await callback.json()) as {
          token: string;
          user: { id: string };
        };
        const [created] = await db
          .select()
          .from(users)
          .where(eq(users.id, body.user.id));
        expect(created?.email).toBe("pending@example.com");
        expect(created?.passwordHash).toBeNull();
        expect(created?.oidcIssuer).toBe(new URL(provider.issuer).href);
        expect(created?.oidcSubject).toBe("pending-sub");
        const [membership] = await db
          .select({ name: groups.name })
          .from(userGroups)
          .innerJoin(groups, eq(groups.id, userGroups.groupId))
          .where(eq(userGroups.userId, body.user.id));
        expect(membership?.name).toBe("users");
        const [consumed] = await db
          .select({ acceptedAt: invites.acceptedAt })
          .from(invites)
          .where(eq(invites.id, invite.id));
        expect(consumed?.acceptedAt).not.toBeNull();
        const me = await fetch(`${base}/api/auth/me`, {
          headers: { authorization: `Bearer ${body.token}` },
        });
        expect(me.status).toBe(200);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("an unverified email claim cannot link an existing account", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "new-subject",
        email: "LINKED@example.com",
        emailVerified: false,
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const local = await createLocalUser(db, admin.id, {
          username: "linked",
          password: "pass",
        });
        await db
          .update(users)
          .set({ email: "linked@example.com" })
          .where(eq(users.id, local.id));

        const callback = await oidcCallback(await oidcLogin(base));
        expect(callback.status).toBe(401);
        expect(
          ((await callback.json()) as { error: { code: string } }).error.code,
        ).toBe("OIDC_FAILED");
        const [stored] = await db
          .select()
          .from(users)
          .where(eq(users.id, local.id));
        expect(stored?.oidcIssuer).toBeNull();
        expect(stored?.oidcSubject).toBeNull();
        expect(await db.select().from(users)).toHaveLength(2);
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("a verified new identity without an invite creates nothing", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "fresh-subject",
        email: "fresh@example.com",
        emailVerified: true,
        preferredUsername: "fresh",
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        await setupAdmin(db, { username: "admin", password: "secret" });

        const callback = await oidcCallback(await oidcLogin(base));
        expect(callback.status).toBe(401);
        expect(
          ((await callback.json()) as { error: { code: string } }).error.code,
        ).toBe("OIDC_FAILED");
        expect(await db.select().from(users)).toHaveLength(1);
        expect(await db.select().from(sessions)).toHaveLength(0);
        expect(await db.select().from(invites)).toHaveLength(0);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("an ID token signed by an unadvertised key fails", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "forged-subject",
        email: "forged@example.com",
        emailVerified: true,
      });
      provider.signWithRogue();
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        await setupAdmin(db, { username: "admin", password: "secret" });

        const callback = await oidcCallback(await oidcLogin(base));
        expect(callback.status).toBe(401);
        expect(
          ((await callback.json()) as { error: { code: string } }).error.code,
        ).toBe("OIDC_FAILED");
        expect(await db.select().from(users)).toHaveLength(1);
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("tampered state and bad flow cookies fail and clear the flow", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "subject-7",
        email: "linked@example.com",
        emailVerified: true,
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const local = await createLocalUser(db, admin.id, {
          username: "linked",
          password: "pass",
        });
        await db
          .update(users)
          .set({ email: "linked@example.com" })
          .where(eq(users.id, local.id));

        const expectFailure = async (response: Response) => {
          expect(response.status).toBe(401);
          expect(
            ((await response.json()) as { error: { code: string } }).error.code,
          ).toBe("OIDC_FAILED");
          expect(response.headers.get("set-cookie")).toContain(
            "pendia_oidc_flow=;",
          );
          expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        };

        const tampered = await oidcLogin(base);
        const mutated = new URL(tampered.callbackUrl ?? "");
        mutated.searchParams.set(
          "state",
          randomBytes(32).toString("base64url"),
        );
        await expectFailure(
          await fetch(mutated, {
            redirect: "manual",
            headers: { cookie: tampered.flowCookie },
          }),
        );

        const missing = await oidcLogin(base);
        await expectFailure(
          await fetch(missing.callbackUrl ?? "", { redirect: "manual" }),
        );

        const malformed = await oidcLogin(base);
        await expectFailure(
          await fetch(malformed.callbackUrl ?? "", {
            redirect: "manual",
            headers: { cookie: "pendia_oidc_flow=!!!" },
          }),
        );

        const [stored] = await db
          .select()
          .from(users)
          .where(eq(users.id, local.id));
        expect(stored?.oidcIssuer).toBeNull();
        expect(await db.select().from(users)).toHaveLength(2);
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("a differing unverified UserInfo email cannot link an account", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider(
        {
          sub: "subject-mismatch",
          email: "verified@example.com",
          emailVerified: true,
        },
        {
          userInfo: {
            sub: "subject-mismatch",
            email: "other@example.com",
          },
        },
      );
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const verified = await createLocalUser(db, admin.id, {
          username: "verified",
          password: "pass",
        });
        await db
          .update(users)
          .set({ email: "verified@example.com" })
          .where(eq(users.id, verified.id));
        const other = await createLocalUser(db, admin.id, {
          username: "other",
          password: "pass",
        });
        await db
          .update(users)
          .set({ email: "other@example.com" })
          .where(eq(users.id, other.id));

        const callback = await oidcCallback(await oidcLogin(base));
        expect(callback.status).toBe(401);
        expect(
          ((await callback.json()) as { error: { code: string } }).error.code,
        ).toBe("OIDC_FAILED");
        const stored = await db.select().from(users);
        for (const row of stored) {
          expect(row.oidcIssuer).toBeNull();
          expect(row.oidcSubject).toBeNull();
        }
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("a trusted proxy forwarding HTTPS yields an https callback", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "proxied-subject",
        email: "proxied@example.com",
        emailVerified: true,
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer, ["127.0.0.1"]);
        await setupAdmin(db, { username: "admin", password: "secret" });

        const params = new URLSearchParams({
          clientName: device.clientName,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
        });
        const start = await fetch(`${base}/api/auth/oidc/login?${params}`, {
          redirect: "manual",
          headers: { "x-forwarded-proto": "https" },
        });
        expect(start.status).toBe(302);
        const location = new URL(start.headers.get("location") ?? "");
        expect(location.searchParams.get("redirect_uri")).toBe(
          `https://127.0.0.1:${server.apiServer?.port}/api/auth/oidc/callback`,
        );
        const cookie = start.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("pendia_oidc_flow=");
        expect(cookie).toContain("Secure");
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));

  test("concurrent invited signups with the same username both succeed", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const provider = await startProvider({
        sub: "twin-1",
        email: "one@example.com",
        emailVerified: true,
        preferredUsername: "Same Name",
      });
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await configureOidc(db, provider.issuer);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const first = await createInvite(db, admin.id, {
          email: "one@example.com",
          expiresInSeconds: 600,
        });
        const second = await createInvite(db, admin.id, {
          email: "two@example.com",
          expiresInSeconds: 600,
        });
        const flowOne = await oidcLogin(base, { invite: first.token });
        provider.setClaims({
          sub: "twin-2",
          email: "two@example.com",
          emailVerified: true,
          preferredUsername: "Same Name",
        });
        const flowTwo = await oidcLogin(base, { invite: second.token });

        const [callbackOne, callbackTwo] = await Promise.all([
          oidcCallback(flowOne),
          oidcCallback(flowTwo),
        ]);
        expect(callbackOne.status).toBe(200);
        expect(callbackTwo.status).toBe(200);
        const bodyOne = (await callbackOne.json()) as {
          user: { id: string; username: string };
        };
        const bodyTwo = (await callbackTwo.json()) as {
          user: { id: string; username: string };
        };
        const usernames = [bodyOne.user.username, bodyTwo.user.username];
        expect(new Set(usernames).size).toBe(2);
        expect(usernames).toContain("same-name");
        const suffixed = usernames.find((name) => name !== "same-name");
        expect(suffixed).toMatch(/^same-name-[0-9a-f]{8}$/);
        expect(await db.select().from(sessions)).toHaveLength(2);
      } finally {
        await server.stop();
        await provider.stop();
      }
    }));
});
