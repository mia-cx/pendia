import { afterEach, expect, test } from "bun:test";
import { createPendiaClient } from "./api.ts";

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
