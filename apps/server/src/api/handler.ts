import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import type { Database } from "../db/client.ts";
import { createDirectPlayHandler } from "../playback/direct.ts";
import type { Transcoder } from "../transcoder/index.ts";
import type { ApiContext } from "./context.ts";
import type { EventBroker } from "./events.ts";
import { createHlsHandler } from "./hls.ts";
import { openApiDocument } from "./openapi.ts";
import { pendiaRouter } from "./router.ts";

const eventStreamPaths = new Set(["/api/events", "/rpc/events/stream"]);

/** Creates the handler that serves the router over /rpc and /api plus the playback file routes. */
export function createApiHandler(
  db: Database,
  events: EventBroker,
  transcoder?: Transcoder,
) {
  const rpc = new RPCHandler<ApiContext>(pendiaRouter);
  const openapi = new OpenAPIHandler<ApiContext>(pendiaRouter);
  const direct = createDirectPlayHandler(db);
  const hls = createHlsHandler(db, transcoder);
  return async (
    request: Request,
    peerAddress: string,
    server: Bun.Server<undefined>,
  ): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/openapi.json" && request.method === "GET")
      return Response.json(await openApiDocument());
    const played = await direct(request, peerAddress);
    if (played !== undefined) return played;
    const streamed = await hls(request, server);
    if (streamed !== undefined) return streamed;
    // Bun.serve drops connections idle for ten seconds; the event stream must outlive that.
    if (eventStreamPaths.has(pathname)) server.timeout(request, 0);
    const context: ApiContext = { db, request, peerAddress, events };
    const result =
      pathname === "/rpc" || pathname.startsWith("/rpc/")
        ? await rpc.handle(request, { prefix: "/rpc", context })
        : await openapi.handle(request, { prefix: "/api", context });
    const response = result.response;
    if (response === undefined) return undefined;
    // Personalised GETs are heuristically cacheable to a shared proxy keyed
    // on the URL; match the auth routes and mark every API response no-store.
    // The openapi.json branch returns earlier and stays cacheable on purpose.
    response.headers.set("cache-control", "no-store");
    response.headers.append("vary", "cookie, authorization");
    return response;
  };
}
