import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import type { Database } from "../db/client.ts";
import type { ApiContext } from "./context.ts";
import type { EventBroker } from "./events.ts";
import { openApiDocument } from "./openapi.ts";
import { pendiaRouter } from "./router.ts";

const eventStreamPaths = new Set(["/api/events", "/rpc/events/stream"]);

/** Creates the handler that serves the router over /rpc and /api. */
export function createApiHandler(db: Database, events: EventBroker) {
  const rpc = new RPCHandler<ApiContext>(pendiaRouter);
  const openapi = new OpenAPIHandler<ApiContext>(pendiaRouter);
  return async (
    request: Request,
    peerAddress: string,
    server: Bun.Server<undefined>,
  ): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/openapi.json" && request.method === "GET")
      return Response.json(await openApiDocument());
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
