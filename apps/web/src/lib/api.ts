import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { pendiaRouter } from "@pendia/server/api";

/** The typed client for the Pendia API. */
export type PendiaClient = RouterClient<typeof pendiaRouter>;

/** Creates a client that talks to the api role, same origin by default. */
export function createPendiaClient(
  options: {
    origin?: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
  } = {},
): PendiaClient {
  const transport = options.fetch;
  const link = new RPCLink({
    url: `${options.origin ?? ""}/rpc`,
    headers: options.headers ?? {},
    fetch:
      transport === undefined ? undefined : (request) => transport(request),
  });
  return createORPCClient<PendiaClient>(link);
}

/** The same-origin client the admin screens use. */
export const client = createPendiaClient();
