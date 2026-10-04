import { AuthError } from "../auth/errors.ts";
import { authenticate } from "../auth/sessions.ts";
import { readAuthSettings } from "../auth/settings.ts";
import { requestIdentity } from "../auth/transport.ts";
import type { Database } from "../db/client.ts";
import {
  type ClientInfo,
  type Query,
  readClient,
  readQuery,
} from "./request.ts";

/** What every Jellyfin route handler receives. */
export type RequestContext = {
  db: Database;
  request: Request;
  url: URL;
  query: Query;
  params: Record<string, string>;
  client: ClientInfo;
  peerAddress: string;
};

/** The context of a route that needs a signed-in caller. */
export type UserContext = RequestContext & {
  caller: Awaited<ReturnType<typeof authenticate>>;
  token: string;
};

type Handler<Context> = (context: Context) => Promise<Response> | Response;

/** One Jellyfin endpoint. Paths use `{name}` parameters and match case-insensitively. */
export type Route = { method: "GET" | "POST" | "DELETE"; path: string } & (
  | { anonymous: true; handle: Handler<RequestContext> }
  | { anonymous?: false; handle: Handler<UserContext> }
);

/** Answers JSON with no caching, as every Jellyfin API response is per-user. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Resolves the caller's address and protocol, trusting forwarding headers from configured proxies only. */
export async function identify({ db, request, peerAddress }: RequestContext) {
  const { trustedProxyAddresses } = await readAuthSettings(db);
  return requestIdentity(request, peerAddress, trustedProxyAddresses);
}

/** Answers 204 No Content. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
}

function compile(route: Route) {
  const pattern = route.path
    .split("/")
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? `(?<${segment.slice(1, -1)}>[^/]+)`
        : segment.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return { route, pattern: new RegExp(`^${pattern}/?$`, "i") };
}

/**
 * Creates the Jellyfin translation layer handler. It answers matched routes, and a
 * JSON 404 for any other path under a Jellyfin root written in Jellyfin's own casing,
 * such as the legacy `/Users/{userId}/Items`. Everything else returns undefined.
 */
export function createJellyfinHandler(db: Database, routes: readonly Route[]) {
  const compiled = routes.map(compile);
  const roots = new Set(routes.map((route) => route.path.split("/")[1]));
  return async (
    request: Request,
    peerAddress: string,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const candidates = compiled.flatMap(({ route, pattern }) => {
      const match = pattern.exec(url.pathname);
      return match === null ? [] : [{ route, params: match.groups ?? {} }];
    });
    if (candidates.length === 0)
      return roots.has(url.pathname.split("/")[1])
        ? failure(404, "NOT_FOUND", "Not found.")
        : undefined;
    const found = candidates.find(
      ({ route }) => route.method === request.method,
    );
    if (found === undefined)
      return failure(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    try {
      const params = Object.fromEntries(
        Object.entries(found.params).map(([name, value]) => [
          name,
          decodeParam(value),
        ]),
      );
      const context: RequestContext = {
        db,
        request,
        url,
        query: readQuery(url.searchParams),
        params,
        client: readClient(request),
        peerAddress,
      };
      if (found.route.anonymous) return await found.route.handle(context);
      const token = context.client.token;
      if (token === undefined) throw new AuthError("UNAUTHENTICATED");
      const caller = await authenticate(db, token);
      return await found.route.handle({ ...context, caller, token });
    } catch (error) {
      if (error instanceof AuthError) {
        const response = failure(error.status, error.code, error.message);
        if (error.retryAfterSeconds !== undefined)
          response.headers.set("Retry-After", String(error.retryAfterSeconds));
        return response;
      }
      console.error(
        JSON.stringify({
          level: "error",
          message: "jellyfin.request.failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return failure(500, "INTERNAL_ERROR", "Request failed.");
    }
  };
}
