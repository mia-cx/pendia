import { AuthError } from "../auth/errors.ts";
import { requireAdmin } from "../auth/permissions.ts";
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
  /** Lets a route outlive Bun's ten second idle timeout, as an HLS segment wait can. */
  server: Timeouts;
};

type Timeouts = Pick<Bun.Server<undefined>, "timeout">;

/** Stands in for Bun's server where a request is not one it accepted, as in tests or a forwarded request. */
export const noTimeouts: Timeouts = { timeout: () => {} };

/** The context of a route that needs a signed-in caller. */
export type UserContext = RequestContext & {
  caller: Awaited<ReturnType<typeof authenticate>>;
  token: string;
};

type Handler<Context> = (context: Context) => Promise<Response> | Response;

/** One Jellyfin endpoint. Paths use `{name}` parameters and match case-insensitively. */
export type Route = {
  method: "GET" | "POST" | "DELETE" | "HEAD";
  path: string;
  admin?: boolean;
  /** Contract coverage distinguishes real core adapters from valid neutral responses. */
  behaviour?: "real" | "neutral";
} & (
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

async function responseFor(request: Request, response: Response) {
  if (request.method !== "HEAD") return response;
  await response.body?.cancel();
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
}

/** Compiles whole and embedded parameters, such as `stream.{container}` and `{index}.jpg`. */
export function routePattern(path: string) {
  const pattern = path
    .split(/(\{[^}]+\})/)
    .map((part) =>
      part.startsWith("{")
        ? `(?<${part.slice(1, -1)}>[^/]+)`
        : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}/?$`, "i");
}

function compile(route: Route) {
  const pattern = routePattern(route.path);
  return { route, pattern };
}

/**
 * Creates the Jellyfin translation layer handler. It answers matched routes, and a
 * JSON 404 for any other path under a Jellyfin root written in Jellyfin's own casing.
 * Everything else returns undefined so Thalia's own screens can use lowercase paths.
 */
export function createJellyfinHandler(db: Database, routes: readonly Route[]) {
  // Literal operations precede parameter routes, so `/Items/Latest` is not an Item id.
  const compiled = routes.map(compile).sort((a, b) => {
    const score = (path: string) => path.replace(/\{[^}]+\}/g, "").length;
    return score(b.route.path) - score(a.route.path);
  });
  const roots = new Set(routes.map((route) => route.path.split("/")[1]));
  return async (
    request: Request,
    peerAddress: string,
    server: Timeouts = noTimeouts,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const candidates = compiled.flatMap(({ route, pattern }) => {
      const match = pattern.exec(url.pathname);
      return match === null ? [] : [{ route, params: match.groups ?? {} }];
    });
    if (candidates.length === 0)
      return roots.has(url.pathname.split("/")[1])
        ? responseFor(request, failure(404, "NOT_FOUND", "Not found."))
        : undefined;
    const found = candidates.find(
      ({ route }) => route.method === request.method,
    );
    if (found === undefined)
      return responseFor(
        request,
        failure(405, "METHOD_NOT_ALLOWED", "Method not allowed."),
      );
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
        server,
      };
      if (found.route.anonymous)
        return responseFor(request, await found.route.handle(context));
      const token = context.client.token;
      if (token === undefined) throw new AuthError("UNAUTHENTICATED");
      const caller = await authenticate(db, token);
      if (found.route.admin) {
        if (caller.credential.kind !== "session")
          throw new AuthError("FORBIDDEN");
        await requireAdmin(db, caller.user.id);
      }
      return responseFor(
        request,
        await found.route.handle({ ...context, caller, token }),
      );
    } catch (error) {
      if (error instanceof AuthError) {
        const response = failure(error.status, error.code, error.message);
        if (error.retryAfterSeconds !== undefined)
          response.headers.set("Retry-After", String(error.retryAfterSeconds));
        return responseFor(request, response);
      }
      console.error(
        JSON.stringify({
          level: "error",
          message: "jellyfin.request.failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return responseFor(
        request,
        failure(500, "INTERNAL_ERROR", "Request failed."),
      );
    }
  };
}
