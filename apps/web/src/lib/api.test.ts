import { afterEach, describe, expect, test } from "bun:test";
import { createPendiaClient, reachServer, ServerUnreachable } from "./api.ts";
import { readFailure } from "./errors.ts";

const pageOrigin = "http://pendia.test:8080";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
});

test("the default client calls the page's own origin", async () => {
  Object.defineProperty(globalThis, "location", {
    value: { origin: pageOrigin },
    configurable: true,
  });
  const requested: string[] = [];
  const client = createPendiaClient({
    fetch: Object.assign(
      async (request: URL | RequestInfo) => {
        requested.push(
          request instanceof Request ? request.url : String(request),
        );
        return Response.json({ json: { complete: true } });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  expect(await client.setup.status()).toEqual({ complete: true });
  expect(requested).toEqual([`${pageOrigin}/rpc/setup/status`]);
});

function answering(respond: () => Promise<Response>) {
  return createPendiaClient({
    origin: pageOrigin,
    fetch: Object.assign(respond, { preconnect: fetch.preconnect }),
  });
}

describe("an unreachable server", () => {
  test("a refused connection reads as unreachable", async () => {
    const client = answering(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const error = await client.setup.status().catch((caught) => caught);
    expect(error).toBeInstanceOf(ServerUnreachable);
    expect(readFailure(error).code).toBe("UNREACHABLE");
  });

  test("a proxy's HTML 502 reads as unreachable", async () => {
    const client = answering(
      async () =>
        new Response("<h1>Bad Gateway</h1>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    const error = await client.setup.status().catch((caught) => caught);
    expect(readFailure(error).code).toBe("UNREACHABLE");
  });

  test("Pendia's own JSON 503 stays a server failure", async () => {
    const client = answering(async () =>
      Response.json(
        { json: { defined: false, code: "SERVICE_UNAVAILABLE", status: 503 } },
        { status: 503 },
      ),
    );
    const error = await client.setup.status().catch((caught) => caught);
    expect(error).not.toBeInstanceOf(ServerUnreachable);
    expect(readFailure(error).code).toBe("UNKNOWN");
  });

  test("an aborted request keeps its abort error", async () => {
    const aborted = new DOMException("Aborted", "AbortError");
    const caught = await reachServer("/rpc", undefined, () =>
      Promise.reject(aborted),
    ).catch((error) => error);
    expect(caught).toBe(aborted);
  });
});
