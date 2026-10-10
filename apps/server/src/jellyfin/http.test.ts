import { expect, test } from "bun:test";
import type { Database } from "../db/client.ts";
import { createJellyfinHandler, json, type Route } from "./http.ts";

const routes: Route[] = [
  {
    method: "GET",
    path: "/System/Info/Public",
    anonymous: true,
    handle: ({ query, client }) =>
      json({ secret: query.get("secret"), client: client.client }),
  },
  {
    method: "GET",
    path: "/Shows/{id}/Seasons",
    anonymous: true,
    handle: ({ params }) => json(params),
  },
  {
    method: "GET",
    path: "/Users/Me",
    handle: ({ caller }) => json(caller),
  },
  {
    method: "GET",
    path: "/Images/{index}.jpg",
    anonymous: true,
    handle: ({ params }) => json(params),
  },
  {
    method: "GET",
    path: "/Shows/Latest/Seasons",
    anonymous: true,
    handle: () => json("latest"),
  },
];

// Anonymous routes and unauthenticated failures never reach the database.
const handle = createJellyfinHandler({} as Database, routes);
const get = (path: string, headers: HeadersInit = {}) =>
  handle(new Request(`http://thalia.test${path}`, { headers }), "127.0.0.1");

test("matches paths and query names case-insensitively", async () => {
  const response = await get("/system/info/public?Secret=s", {
    "X-Emby-Authorization": 'MediaBrowser Client="Infuse-Direct"',
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    secret: "s",
    client: "Infuse-Direct",
  });
});

test("passes path parameters", async () => {
  const response = await get("/Shows/abc/Seasons");
  expect(await response?.json()).toEqual({ id: "abc" });
  expect(await (await get("/Images/2.jpg"))?.json()).toEqual({ index: "2" });
  expect(await (await get("/Shows/Latest/Seasons"))?.json()).toBe("latest");
});

test("answers legacy per-user routes with a JSON 404", async () => {
  for (const path of [
    "/Users/0192f0c47b1a7c3e9a1b2c3d4e5f6a7b/Items",
    "/Users/x/Views",
  ]) {
    const response = await get(path);
    expect(response?.status).toBe(404);
    expect(response?.headers.get("content-type")).toContain("application/json");
  }
});

test("leaves lowercase web screens to the SPA", async () => {
  expect(
    await get("/shows/0192f0c4-7b1a-7c3e-9a1b-2c3d4e5f6a7b"),
  ).toBeUndefined();
  expect(await get("/admin")).toBeUndefined();
});

test("rejects unauthenticated calls to user routes and wrong methods", async () => {
  expect((await get("/Users/Me"))?.status).toBe(401);
  const posted = await handle(
    new Request("http://thalia.test/Users/Me", { method: "POST" }),
    "127.0.0.1",
  );
  expect(posted?.status).toBe(405);
});
