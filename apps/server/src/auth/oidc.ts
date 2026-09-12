import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as oauth from "oauth4webapi";
import type { Database } from "../db/client.ts";
import { groups, userGroups, users } from "../db/schema/index.ts";
import { publicUserFields } from "./accounts.ts";
import { AuthError, postgresCode } from "./errors.ts";
import { claimInvite } from "./invites.ts";
import { issueSession } from "./sessions.ts";
import { readAuthSettings } from "./settings.ts";

type AuthSettings = Awaited<ReturnType<typeof readAuthSettings>>;
type OidcConfig = NonNullable<AuthSettings["oidc"]>;

type OidcStartInput = {
  clientName: string;
  deviceId: string;
  deviceName: string;
  inviteToken?: string;
};

type OidcFlow = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  clientName: string;
  deviceId: string;
  deviceName: string;
  inviteToken?: string;
};

type OidcIdentity = {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  preferredUsername?: string;
  name?: string;
};

const callbackPath = "/api/auth/oidc/callback";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const emailPattern = /^[^\s@]+@[^\s@]+$/;
const flowPattern = /^[A-Za-z0-9_-]+$/;

function failed(): never {
  throw new AuthError("OIDC_FAILED");
}

function readDevice(input: {
  clientName: unknown;
  deviceId: unknown;
  deviceName: unknown;
}) {
  const clientName =
    typeof input.clientName === "string" ? input.clientName.trim() : "";
  const deviceId = typeof input.deviceId === "string" ? input.deviceId : "";
  const deviceName =
    typeof input.deviceName === "string" ? input.deviceName.trim() : "";
  if (
    clientName.length < 1 ||
    clientName.length > 128 ||
    deviceName.length < 1 ||
    deviceName.length > 128 ||
    deviceId.length < 1 ||
    deviceId.length > 128
  )
    throw new AuthError("INVALID_INPUT");
  return { clientName, deviceId, deviceName };
}

const loopbackHosts = ["localhost", "127.0.0.1", "[::1]", "::1"];

function endpoint(value: string | undefined, allowLoopbackHttp: boolean) {
  if (value === undefined) failed();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failed();
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      allowLoopbackHttp &&
      loopbackHosts.includes(url.hostname)
    )
  )
    failed();
  return url;
}

async function discover(config: OidcConfig) {
  const options =
    config.issuer.protocol === "http:"
      ? { [oauth.allowInsecureRequests]: true }
      : {};
  const allowLoopbackHttp = config.issuer.protocol === "http:";
  const response = await oauth.discoveryRequest(config.issuer, options);
  const as = await oauth.processDiscoveryResponse(config.issuer, response);
  endpoint(as.authorization_endpoint, allowLoopbackHttp);
  endpoint(as.token_endpoint, allowLoopbackHttp);
  endpoint(as.jwks_uri, allowLoopbackHttp);
  if (as.userinfo_endpoint !== undefined)
    endpoint(as.userinfo_endpoint, allowLoopbackHttp);
  const client: oauth.Client = { client_id: config.clientId };
  return { as, client, options };
}

function flowSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 256 ||
    !flowPattern.test(value)
  )
    failed();
  return value;
}

function flowText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 128
  )
    failed();
  return value;
}

function pickString(primary: unknown, fallback: unknown) {
  const value = primary === undefined ? fallback : primary;
  if (value === undefined) return undefined;
  if (typeof value !== "string") failed();
  return value;
}

function pickBoolean(primary: unknown, fallback: unknown) {
  const value = primary === undefined ? fallback : primary;
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") failed();
  return value;
}

function flowDeviceId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128)
    failed();
  return value;
}

function decodeFlow(encoded: string): OidcFlow {
  if (encoded.length < 1 || encoded.length > 4096 || !flowPattern.test(encoded))
    failed();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    failed();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    failed();
  const raw = parsed as Record<string, unknown>;
  const inviteToken = raw.inviteToken;
  if (
    inviteToken !== undefined &&
    (typeof inviteToken !== "string" || !tokenPattern.test(inviteToken))
  )
    failed();
  if (typeof raw.redirectUri !== "string") failed();
  let redirect: URL;
  try {
    redirect = new URL(raw.redirectUri as string);
  } catch {
    failed();
  }
  if (
    !["http:", "https:"].includes(redirect.protocol) ||
    redirect.pathname !== callbackPath ||
    redirect.search ||
    redirect.hash
  )
    failed();
  return {
    state: flowSecret(raw.state),
    nonce: flowSecret(raw.nonce),
    codeVerifier: flowSecret(raw.codeVerifier),
    redirectUri: raw.redirectUri as string,
    clientName: flowText(raw.clientName),
    deviceId: flowDeviceId(raw.deviceId),
    deviceName: flowText(raw.deviceName),
    inviteToken: inviteToken as string | undefined,
  };
}

/** Starts an OIDC authorization-code flow and returns its redirect and cookie state. */
export async function startOidcLogin(
  config: OidcConfig,
  redirectUri: string,
  input: OidcStartInput,
): Promise<{ authorizationUrl: URL; flow: string }> {
  const device = readDevice(input);
  if (input.inviteToken !== undefined && !tokenPattern.test(input.inviteToken))
    throw new AuthError("INVALID_INVITE");
  try {
    let callback: URL;
    try {
      callback = new URL(redirectUri);
    } catch {
      failed();
    }
    if (
      !["http:", "https:"].includes(callback.protocol) ||
      callback.pathname !== callbackPath ||
      callback.search ||
      callback.hash
    )
      failed();
    const { as, client } = await discover(config);
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const authorizationUrl = new URL(as.authorization_endpoint as string);
    authorizationUrl.searchParams.set("client_id", client.client_id);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", config.scopes.join(" "));
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    const flow: OidcFlow = {
      state,
      nonce,
      codeVerifier,
      redirectUri,
      ...device,
      inviteToken: input.inviteToken,
    };
    return {
      authorizationUrl,
      flow: Buffer.from(JSON.stringify(flow)).toString("base64url"),
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    failed();
  }
}

async function availableUsername(
  db: Pick<Database, "select">,
  preferredUsername: string | undefined,
  email: string,
) {
  const source = preferredUsername?.trim() || email.split("@")[0] || "";
  const base =
    source
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 64) || "user";
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${base}`)
    .limit(1);
  if (!taken) return base;
  return `${base.slice(0, 55)}-${randomBytes(4).toString("hex")}`;
}

/** Finishes an OIDC flow and returns a linked user's first device session. */
export async function finishOidcLogin(
  db: Database,
  config: OidcConfig,
  callbackUrl: URL,
  encodedFlow: string,
) {
  const flow = decodeFlow(encodedFlow);
  if (`${callbackUrl.origin}${callbackUrl.pathname}` !== flow.redirectUri)
    failed();
  let identity: OidcIdentity;
  try {
    const { as, client, options } = await discover(config);
    const params = oauth.validateAuthResponse(
      as,
      client,
      callbackUrl,
      flow.state,
    );
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretBasic(config.clientSecret),
      params,
      flow.redirectUri,
      flow.codeVerifier,
      options,
    );
    const result = await oauth.processAuthorizationCodeResponse(
      as,
      client,
      tokenResponse,
      { expectedNonce: flow.nonce, requireIdToken: true },
    );
    await oauth.validateApplicationLevelSignature(as, tokenResponse, options);
    const idClaims = oauth.getValidatedIdTokenClaims(result);
    if (!idClaims) failed();
    let userInfo: oauth.UserInfoResponse | undefined;
    if (as.userinfo_endpoint !== undefined) {
      if (typeof result.access_token !== "string") failed();
      userInfo = await oauth.processUserInfoResponse(
        as,
        client,
        idClaims.sub,
        await oauth.userInfoRequest(
          as,
          client,
          result.access_token,
          options,
        ),
      );
    }
    identity = {
      sub: idClaims.sub,
      email: pickString(userInfo?.email, idClaims.email),
      emailVerified: pickBoolean(
        userInfo?.email_verified,
        idClaims.email_verified,
      ),
      preferredUsername: pickString(
        userInfo?.preferred_username,
        idClaims.preferred_username,
      ),
      name: pickString(userInfo?.name, idClaims.name),
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    failed();
  }
  const device = {
    clientName: flow.clientName,
    deviceId: flow.deviceId,
    deviceName: flow.deviceName,
  };
  const settings = await readAuthSettings(db);
  try {
    return await db.transaction(async (tx) => {
      const [linked] = await tx
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(
          and(
            eq(users.oidcIssuer, config.issuer.href),
            eq(users.oidcSubject, identity.sub),
          ),
        )
        .for("update");
      if (linked) {
        if (linked.disabledAt !== null) failed();
        return issueSession(
          tx,
          linked.id,
          device,
          settings.sessionMaxAgeSeconds,
        );
      }
      const email = identity.email?.trim().toLowerCase() ?? "";
      if (email.length > 254 || !emailPattern.test(email)) failed();
      if (identity.emailVerified === true) {
        const [existing] = await tx
          .select({
            id: users.id,
            disabledAt: users.disabledAt,
            oidcIssuer: users.oidcIssuer,
          })
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .for("update");
        if (existing) {
          if (existing.disabledAt !== null || existing.oidcIssuer !== null)
            failed();
          await tx
            .update(users)
            .set({
              oidcIssuer: config.issuer.href,
              oidcSubject: identity.sub,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(users.id, existing.id));
          return issueSession(
            tx,
            existing.id,
            device,
            settings.sessionMaxAgeSeconds,
          );
        }
      }
      if (flow.inviteToken === undefined) failed();
      await claimInvite(tx, flow.inviteToken, email);
      const [members] = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.name, "users"), eq(groups.builtIn, true)))
        .limit(1);
      if (!members)
        throw new Error("Seeded users group missing; run migrations first.");
      const username = await availableUsername(
        tx,
        identity.preferredUsername,
        email,
      );
      const displayName = (
        identity.name?.trim() ||
        identity.preferredUsername?.trim() ||
        email
      ).slice(0, 128);
      const [user] = await tx
        .insert(users)
        .values({
          username,
          displayName,
          email,
          oidcIssuer: config.issuer.href,
          oidcSubject: identity.sub,
        })
        .returning(publicUserFields);
      if (!user) throw new Error("User insert returned no row.");
      await tx
        .insert(userGroups)
        .values({ userId: user.id, groupId: members.id });
      return issueSession(tx, user.id, device, settings.sessionMaxAgeSeconds);
    });
  } catch (error) {
    if (postgresCode(error) === "23505") failed();
    throw error;
  }
}
