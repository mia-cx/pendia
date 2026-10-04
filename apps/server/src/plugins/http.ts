import { AuthError } from "../auth/errors.ts";
import { checkOrigin, readSessionToken } from "../auth/http.ts";
import { authenticate } from "../auth/sessions.ts";
import { readAuthSettings } from "../auth/settings.ts";
import { requestIdentity } from "../auth/transport.ts";
import type { Database } from "../db/client.ts";
import { readBoundedBytes } from "../metadata/bounded-body.ts";
import { PluginFailed, type PluginRuntime } from "./runtime.ts";

/** The path prefix plugin routes are served under. */
export const pluginRoutePrefix = "/plugins/";

const maxBodyBytes = 1024 * 1024;

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function callerId(db: Database, request: Request) {
  try {
    return (await authenticate(db, readSessionToken(request))).user.id;
  } catch (error) {
    if (error instanceof AuthError && error.code === "UNAUTHENTICATED")
      return null;
    throw error;
  }
}

async function readBody(request: Request): Promise<unknown> {
  if (request.body === null) return null;
  const bytes = await readBoundedBytes(
    request.body,
    maxBodyBytes,
    () => new AuthError("BODY_TOO_LARGE"),
  );
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
}

/**
 * Serves plugin routes under `/plugins/<name>/`, with a scoped name taking two
 * segments. The caller's user id is passed when a session authenticates, and
 * a POST passes the same origin check as API mutations.
 */
export function createPluginRouteHandler(db: Database, plugins: PluginRuntime) {
  return async (
    request: Request,
    peerAddress: string,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(pluginRoutePrefix)) return undefined;
    if (request.method !== "GET" && request.method !== "POST")
      return json(405, { error: "Plugin routes take GET or POST." });
    let segments: string[];
    try {
      segments = url.pathname
        .slice(pluginRoutePrefix.length)
        .split("/")
        .map(decodeURIComponent);
    } catch {
      return json(400, { error: "The path is not valid." });
    }
    const nameLength = segments[0]?.startsWith("@") ? 2 : 1;
    const name = segments.slice(0, nameLength).join("/");
    const path = `/${segments.slice(nameLength).join("/")}`;
    try {
      if (request.method === "POST") {
        const config = await readAuthSettings(db);
        const identity = requestIdentity(
          request,
          peerAddress,
          config.trustedProxyAddresses,
        );
        checkOrigin(request, identity.secure);
      }
      const response = await plugins.route(name, request.method, path, {
        path,
        query: Object.fromEntries(url.searchParams),
        body: request.method === "POST" ? await readBody(request) : null,
        userId: await callerId(db, request),
      });
      if (response === null)
        return json(404, { error: "No such plugin route." });
      return json(response.status, response.body ?? null);
    } catch (error) {
      if (error instanceof AuthError)
        return json(error.status, { error: error.message });
      if (error instanceof PluginFailed)
        return json(500, { error: `The plugin ${name} failed.` });
      throw error;
    }
  };
}
