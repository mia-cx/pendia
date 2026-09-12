import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import type { Database } from "../db/client.ts";
import type { ApiContext } from "./context.ts";
import { pendiaRouter } from "./router.ts";

/** Creates the handler that serves the router over /rpc and /api. */
export function createApiHandler(db: Database) {
  const rpc = new RPCHandler<ApiContext>(pendiaRouter);
  const openapi = new OpenAPIHandler<ApiContext>(pendiaRouter);
  return async (
    request: Request,
    peerAddress: string,
  ): Promise<Response | undefined> => {
    const context: ApiContext = { db, request, peerAddress };
    const { pathname } = new URL(request.url);
    const result =
      pathname === "/rpc" || pathname.startsWith("/rpc/")
        ? await rpc.handle(request, { prefix: "/rpc", context })
        : await openapi.handle(request, { prefix: "/api", context });
    return result.response;
  };
}
