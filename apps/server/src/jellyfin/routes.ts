import type { createHlsHandler } from "../api/hls.ts";
import type { createArtworkHandler } from "../metadata/artwork-http.ts";
import type { Route } from "./http.ts";
import { imageRoutes } from "./images.ts";
import { browseRoutes } from "./items.ts";
import { playbackRoutes } from "./playback.ts";
import { quickConnectRoutes } from "./quick-connect.ts";
import { systemRoutes } from "./system.ts";
import { userRoutes } from "./users.ts";

/** Every Jellyfin endpoint Pendia serves, in one table. Images and HLS reuse the handlers the api mounts. */
export function jellyfinRoutes(
  artwork: ReturnType<typeof createArtworkHandler>,
  hls: ReturnType<typeof createHlsHandler>,
): Route[] {
  return [
    ...systemRoutes,
    ...userRoutes,
    ...quickConnectRoutes,
    ...browseRoutes,
    ...imageRoutes(artwork),
    ...playbackRoutes(hls),
  ];
}
