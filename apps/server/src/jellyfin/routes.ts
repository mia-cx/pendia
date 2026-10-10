import type { createHlsHandler } from "../api/hls.ts";
import type { createArtworkHandler } from "../metadata/artwork-http.ts";
import type { MetadataProviderOptions } from "../metadata/providers.ts";
import type { SubtitleProviderOptions } from "../subtitles/providers.ts";
import { accountRoutes, preferenceRoutes } from "./accounts.ts";
import { additionalBrowseRoutes, browseAsUser } from "./browse.ts";
import { neutralAdapters } from "./coverage.ts";
import { deviceRoutes } from "./devices.ts";
import { type RequestContext, type Route, routePattern } from "./http.ts";
import { imageRoutes } from "./images.ts";
import { browseRoutes } from "./items.ts";
import { libraryRoutes } from "./libraries.ts";
import { metadataLookupRoutes } from "./metadata.ts";
import { neutralResponse } from "./neutral.ts";
import { accessOf, operations } from "./openapi.ts";
import { playbackRoutes } from "./playback.ts";
import { progressRoutes } from "./progress.ts";
import { quickConnectRoutes } from "./quick-connect.ts";
import { subtitleRoutes } from "./subtitles.ts";
import { systemRoutes } from "./system.ts";
import { userRoutes } from "./users.ts";

/** Every Jellyfin endpoint Thalia serves, in one table. Images and HLS reuse the handlers the api mounts. */
export function jellyfinRoutes(
  artwork: ReturnType<typeof createArtworkHandler>,
  hls: ReturnType<typeof createHlsHandler>,
  metadata: MetadataProviderOptions = {},
  subtitles: SubtitleProviderOptions = {},
): Route[] {
  const implemented = [
    ...[...additionalBrowseRoutes, ...browseRoutes].map(browseAsUser),
    ...accountRoutes,
    ...libraryRoutes,
    ...metadataLookupRoutes(metadata),
    ...preferenceRoutes,
    ...deviceRoutes,
    ...systemRoutes,
    ...userRoutes,
    ...quickConnectRoutes,
    ...imageRoutes(artwork),
    ...playbackRoutes(hls),
    ...progressRoutes,
    ...subtitleRoutes(subtitles),
  ];
  const shape = (path: string) =>
    path.replace(/\{[^}]+\}/g, "{}").toLowerCase();
  const aliases: Record<string, string> = {
    GetVideoStream: "/Videos/{id}/{name}",
    GetVideoStreamByContainer: "/Videos/{id}/{name}",
  };
  const mirrored = operations.map((operation): Route => {
    const existing = implemented.find(
      (route) =>
        route.method === operation.method &&
        (shape(route.path) === shape(operation.path) ||
          route.path === aliases[operation.operationId]),
    );
    const access = accessOf(operation);
    if (existing !== undefined) {
      // Core adapters predate the official parameter names. Keep their local names at the boundary.
      const pattern = routePattern(existing.path);
      const behaviour = neutralAdapters.has(operation.operationId)
        ? "neutral"
        : "real";
      const params = (context: RequestContext) =>
        Object.fromEntries(
          Object.entries(pattern.exec(context.url.pathname)?.groups ?? {}).map(
            ([name, value]) => [name, decodeURIComponent(value)],
          ),
        );
      if (existing.anonymous)
        return {
          ...existing,
          path: operation.path,
          behaviour,
          handle: (context: RequestContext) =>
            existing.handle({ ...context, params: params(context) }),
        };
      return {
        ...existing,
        path: operation.path,
        behaviour,
        admin: access.admin,
        handle: (context) =>
          existing.handle({ ...context, params: params(context) }),
      };
    }
    if (access.anonymous)
      return {
        method: operation.method,
        path: operation.path,
        anonymous: true,
        behaviour: "neutral",
        handle: () => neutralResponse(operation),
      };
    return {
      method: operation.method,
      path: operation.path,
      admin: access.admin,
      behaviour: "neutral",
      handle: () => neutralResponse(operation),
    };
  });
  // HLS and older client aliases remain useful even when the latest contract does not list them.
  const extra = implemented.filter(
    (route) =>
      !operations.some(
        (operation) =>
          route.method === operation.method &&
          shape(route.path) === shape(operation.path),
      ),
  );
  return [...mirrored, ...extra];
}
