import type { Database } from "../db/client.ts";
import { setupAdmin } from "./accounts.ts";
import { AuthError } from "./errors.ts";
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
} as const;

function respond(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
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

function optionalString(
  object: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AuthError("INVALID_INPUT");
  return value;
}

function checkOrigin(request: Request, secure: boolean): void {
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AuthError("FORBIDDEN");
  const origin = request.headers.get("origin");
  if (origin === null) return;
  const expected = `${secure ? "https" : "http"}://${new URL(request.url).host}`;
  if (origin !== expected) throw new AuthError("FORBIDDEN");
}

/** Reads the session token from a Bearer header or the session cookie. */
export function readSessionToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = authorization.match(bearerPattern);
    if (!match?.[1]) throw new AuthError("UNAUTHENTICATED");
    return match[1];
  }
  const header = request.headers.get("cookie");
  if (header === null) throw new AuthError("UNAUTHENTICATED");
  const values = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${sessionCookieName}=`))
    .map((pair) => pair.slice(sessionCookieName.length + 1));
  if (values.length !== 1 || !tokenPattern.test(values[0] ?? ""))
    throw new AuthError("UNAUTHENTICATED");
  return values[0] as string;
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
        default:
          throw new AuthError("NOT_FOUND");
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}
