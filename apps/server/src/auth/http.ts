import type { Database } from "../db/client.ts";
import { setupAdmin } from "./accounts.ts";
import { AuthError } from "./errors.ts";
import { acceptLocalInvite, createInvite } from "./invites.ts";
import { finishOidcLogin, startOidcLogin } from "./oidc.ts";
import {
  authenticate,
  login,
  revokeApiKey,
  revokeSession,
} from "./sessions.ts";
import { readAuthSettings } from "./settings.ts";
import { requestIdentity } from "./transport.ts";

/** The session cookie the auth routes set and the API documents. */
export const sessionCookieName = "pendia_session";
const maxBodyBytes = 16_384;
const cookieMaxAgeSeconds = 34_560_000;
const bearerPattern = /^Bearer ([A-Za-z0-9_-]{43})$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const routes = {
  "/api/auth/setup": "POST",
  "/api/auth/login": "POST",
  "/api/auth/logout": "POST",
  "/api/auth/me": "GET",
  "/api/auth/invites": "POST",
  "/api/auth/invites/accept": "POST",
  "/api/auth/oidc/login": "GET",
  "/api/auth/oidc/callback": "GET",
} as const;

function respond(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  const merged = new Headers(headers);
  if (!merged.has("Cache-Control")) merged.set("Cache-Control", "no-store");
  if (!merged.has("X-Content-Type-Options"))
    merged.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers: merged });
}

function errorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return respond(
      { error: { code: error.code, message: error.message } },
      error.status,
      error.retryAfterSeconds === undefined
        ? {}
        : { "Retry-After": String(error.retryAfterSeconds) },
    );
  }
  console.error(
    JSON.stringify({ level: "error", message: "auth.request.failed" }),
  );
  return respond(
    { error: { code: "INTERNAL_ERROR", message: "Auth request failed." } },
    500,
  );
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type");
  if (
    contentType === null ||
    contentType.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new AuthError("INVALID_INPUT");
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBodyBytes)
    throw new AuthError("BODY_TOO_LARGE");
  const body = request.body;
  if (body === null) throw new AuthError("INVALID_INPUT");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new AuthError("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AuthError("INVALID_INPUT");
  return parsed as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, name: string): string {
  const value = object[name];
  if (typeof value !== "string") throw new AuthError("INVALID_INPUT");
  return value;
}

function requiredNumber(object: Record<string, unknown>, name: string): number {
  const value = object[name];
  if (typeof value !== "number") throw new AuthError("INVALID_INPUT");
  return value;
}

function optionalString(
  object: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AuthError("INVALID_INPUT");
  return value;
}

/** Rejects cross-site requests and foreign Origin headers on cookie-capable calls. */
export function checkOrigin(request: Request, secure: boolean): void {
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AuthError("FORBIDDEN");
  const origin = request.headers.get("origin");
  if (origin === null) return;
  const expected = `${secure ? "https" : "http"}://${new URL(request.url).host}`;
  if (origin !== expected) throw new AuthError("FORBIDDEN");
}

function effectiveUrl(request: Request, secure: boolean) {
  const url = new URL(request.url);
  url.protocol = secure ? "https:" : "http:";
  return url;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) throw new AuthError("INVALID_INPUT");
  return value;
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;
  const values = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${name}=`))
    .map((pair) => pair.slice(name.length + 1));
  if (values.length !== 1) return undefined;
  return values[0];
}

/** Reads the session token from a Bearer header or the session cookie. */
export function readSessionToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = authorization.match(bearerPattern);
    if (!match?.[1]) throw new AuthError("UNAUTHENTICATED");
    return match[1];
  }
  const cookie = readCookie(request, sessionCookieName);
  if (cookie === undefined || !tokenPattern.test(cookie))
    throw new AuthError("UNAUTHENTICATED");
  return cookie;
}

function sessionCookie(token: string, secure: boolean, expiresAt: Date | null) {
  const maxAge =
    expiresAt === null
      ? cookieMaxAgeSeconds
      : Math.max(
          1,
          Math.min(
            cookieMaxAgeSeconds,
            Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
          ),
        );
  return `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

const clearedCookie = (secure: boolean) =>
  `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

const oidcFlowCookieName = "pendia_oidc_flow";

const oidcFlowPath = "/api/auth/oidc/callback";

function oidcFlowCookie(flow: string, secure: boolean) {
  return `${oidcFlowCookieName}=${flow}; Path=${oidcFlowPath}; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`;
}

const clearedOidcFlowCookie = (secure: boolean) =>
  `${oidcFlowCookieName}=; Path=${oidcFlowPath}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

/** Creates the JSON auth handler for /api/auth routes. */
export function createAuthHandler(db: Database) {
  return async (request: Request, peerAddress: string): Promise<Response> => {
    try {
      const { pathname } = new URL(request.url);
      const method = routes[pathname as keyof typeof routes];
      if (method === undefined)
        return respond(
          {
            error: {
              code: "NOT_FOUND",
              message: "Auth record not found.",
            },
          },
          404,
        );
      if (request.method !== method)
        return respond(
          {
            error: {
              code: "METHOD_NOT_ALLOWED",
              message: "Method not allowed.",
            },
          },
          405,
          { Allow: method },
        );

      const config = await readAuthSettings(db);
      const identity = requestIdentity(
        request,
        peerAddress,
        config.trustedProxyAddresses,
      );

      switch (pathname) {
        case "/api/auth/setup": {
          checkOrigin(request, identity.secure);
          const body = await readJsonObject(request);
          const user = await setupAdmin(db, {
            username: requiredString(body, "username"),
            password: requiredString(body, "password"),
            displayName: optionalString(body, "displayName"),
          });
          return respond({ user }, 201);
        }
        case "/api/auth/login": {
          checkOrigin(request, identity.secure);
          const body = await readJsonObject(request);
          const result = await login(
            db,
            {
              username: requiredString(body, "username"),
              password: requiredString(body, "password"),
              clientName: requiredString(body, "clientName"),
              deviceId: requiredString(body, "deviceId"),
              deviceName: requiredString(body, "deviceName"),
            },
            identity.address,
          );
          return respond(result, 200, {
            "Set-Cookie": sessionCookie(
              result.token,
              identity.secure,
              result.session.expiresAt,
            ),
          });
        }
        case "/api/auth/me": {
          const auth = await authenticate(db, readSessionToken(request));
          return respond(auth, 200);
        }
        case "/api/auth/logout": {
          checkOrigin(request, identity.secure);
          const auth = await authenticate(db, readSessionToken(request));
          if (auth.credential.kind === "session")
            await revokeSession(db, auth.user.id, auth.credential.id);
          else await revokeApiKey(db, auth.user.id, auth.credential.id);
          return respond({ ok: true }, 200, {
            "Set-Cookie": clearedCookie(identity.secure),
          });
        }
        case "/api/auth/invites": {
          checkOrigin(request, identity.secure);
          const auth = await authenticate(db, readSessionToken(request));
          const body = await readJsonObject(request);
          const result = await createInvite(db, auth.user.id, {
            email: requiredString(body, "email"),
            expiresInSeconds: requiredNumber(body, "expiresInSeconds"),
          });
          return respond(result, 201);
        }
        case "/api/auth/invites/accept": {
          checkOrigin(request, identity.secure);
          const body = await readJsonObject(request);
          const result = await acceptLocalInvite(db, {
            token: requiredString(body, "token"),
            username: requiredString(body, "username"),
            password: requiredString(body, "password"),
            displayName: optionalString(body, "displayName"),
            clientName: requiredString(body, "clientName"),
            deviceId: requiredString(body, "deviceId"),
            deviceName: requiredString(body, "deviceName"),
          });
          return respond(result, 201, {
            "Set-Cookie": sessionCookie(
              result.token,
              identity.secure,
              result.session.expiresAt,
            ),
          });
        }
        case "/api/auth/oidc/login": {
          if (!config.oidc) throw new AuthError("NOT_FOUND");
          const url = effectiveUrl(request, identity.secure);
          const result = await startOidcLogin(
            config.oidc,
            new URL(oidcFlowPath, url).href,
            {
              clientName: requiredQuery(url, "clientName"),
              deviceId: requiredQuery(url, "deviceId"),
              deviceName: requiredQuery(url, "deviceName"),
              inviteToken: optionalQuery(url, "invite"),
            },
          );
          return new Response(null, {
            status: 302,
            headers: {
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              Location: result.authorizationUrl.href,
              "Set-Cookie": oidcFlowCookie(result.flow, identity.secure),
            },
          });
        }
        case "/api/auth/oidc/callback": {
          if (!config.oidc) throw new AuthError("NOT_FOUND");
          try {
            const flow = readCookie(request, oidcFlowCookieName);
            if (flow === undefined) throw new AuthError("OIDC_FAILED");
            const result = await finishOidcLogin(
              db,
              config.oidc,
              effectiveUrl(request, identity.secure),
              flow,
            );
            const headers = new Headers();
            headers.append(
              "Set-Cookie",
              sessionCookie(
                result.token,
                identity.secure,
                result.session.expiresAt,
              ),
            );
            headers.append(
              "Set-Cookie",
              clearedOidcFlowCookie(identity.secure),
            );
            return respond(result, 200, headers);
          } catch (error) {
            const response = errorResponse(error);
            response.headers.append(
              "Set-Cookie",
              clearedOidcFlowCookie(identity.secure),
            );
            return response;
          }
        }
        default:
          throw new AuthError("NOT_FOUND");
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}
