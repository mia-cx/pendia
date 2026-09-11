import { expect, test } from "bun:test";
import { startApiServer } from "./api.ts";

test("the api server answers its liveness check", async () => {
  const server = startApiServer(0);

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);

    expect(response.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});
