import type { Route } from "./http.ts";
import { quickConnectRoutes } from "./quick-connect.ts";
import { systemRoutes } from "./system.ts";
import { userRoutes } from "./users.ts";

/** Every Jellyfin endpoint Pendia serves, in one table. Playback adds its rows here. */
export function jellyfinRoutes(): Route[] {
  return [...systemRoutes, ...userRoutes, ...quickConnectRoutes];
}
