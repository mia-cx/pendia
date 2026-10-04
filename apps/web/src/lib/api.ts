import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { pendiaRouter } from "@pendia/server/api";

/** The typed client for the Pendia API. */
export type PendiaClient = RouterClient<typeof pendiaRouter>;

/** Thrown when no Pendia server answered: the network failed or a gateway stood in for it. */
export class ServerUnreachable extends Error {
  constructor(options?: ErrorOptions) {
    super("The Pendia server is unreachable.", options);
    this.name = "ServerUnreachable";
  }
}

const gatewayStatuses = new Set([502, 503, 504]);

/** Fetches, turning a failed connection or a proxy's own error page into {@link ServerUnreachable}. */
export async function reachServer(
  input: RequestInfo | URL,
  init?: RequestInit,
  transport: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await transport(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ServerUnreachable({ cause: error });
  }
  // Pendia answers its own 503s in JSON; anything else is a proxy whose upstream is down.
  const json = response.headers.get("content-type")?.includes("json") ?? false;
  if (gatewayStatuses.has(response.status) && !json)
    throw new ServerUnreachable();
  return response;
}

/** Creates a client that talks to the api role, same origin by default. */
export function createPendiaClient(
  options: {
    origin?: string;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
    /** Lets a request outlive the page, for the final report as a tab closes. */
    keepalive?: boolean;
  } = {},
): PendiaClient {
  const link = new RPCLink({
    // oRPC builds `new URL(url)`, which rejects a bare path, so same origin
    // resolves against the page at call time.
    url: () => `${options.origin ?? location.origin}/rpc`,
    headers: options.headers ?? {},
    fetch: (request, init) =>
      reachServer(
        request,
        options.keepalive ? { ...init, keepalive: true } : init,
        options.fetch,
      ),
  });
  return createORPCClient<PendiaClient>(link);
}

/** The same-origin client every screen uses. */
export const client = createPendiaClient();
