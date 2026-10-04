import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { createApiHandler } from "./api/handler.ts";
import type { createAuthHandler } from "./auth/http.ts";
import type { createJellyfinHandler } from "./jellyfin/http.ts";
import {
  type createJellyfinSocket,
  type SocketData,
  socketPath,
} from "./jellyfin/socket.ts";
import type { createServarrWebhookHandler } from "./libraries/webhooks.ts";
import type { createArtworkHandler } from "./metadata/artwork-http.ts";
import type { createPluginRouteHandler } from "./plugins/http.ts";
import type { createSubtitleHandler } from "./subtitles/http.ts";
import type { createWatcherHandler } from "./watcher/http.ts";

const defaultWebRoot = fileURLToPath(
  new URL("../../web/build/", import.meta.url),
);

/** Reads a TCP port from an environment variable, falling back when unset. */
export function readPort(name: string, fallback: number): number {
  const value = Bun.env[name];
  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `${name} must be an integer from 1 to 65535. Found "${value}".`,
    );
  }

  return port;
}

function isApplicationPath(pathname: string): boolean {
  return !["/api", "/rpc"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

async function serveWeb(pathname: string, root: string): Promise<Response> {
  const webRoot = resolve(root);
  const relativePath = pathname.endsWith("/")
    ? `${pathname.slice(1)}index.html`
    : pathname.slice(1);
  const requestedPath = resolve(webRoot, relativePath);
  const insideWebRoot = requestedPath.startsWith(`${webRoot}${sep}`);

  if (insideWebRoot) {
    const file = Bun.file(requestedPath);

    if (await file.exists()) {
      return new Response(file);
    }
  }

  // Client-side routes fall back to the SPA shell; prerendered pages keep their own files.
  return new Response(Bun.file(resolve(webRoot, "200.html")));
}

/**
 * Starts the HTTP server for the api role. `ready` answers the readiness probe;
 * it must resolve, never throw, so a lost database becomes a 503 and not a dropped connection.
 */
export function startApiServer(
  ready: () => Promise<boolean>,
  port = readPort("PENDIA_PORT", 3000),
  handlers: {
    auth?: ReturnType<typeof createAuthHandler>;
    api?: ReturnType<typeof createApiHandler>;
    webhooks?: ReturnType<typeof createServarrWebhookHandler>;
    artwork?: ReturnType<typeof createArtworkHandler>;
    subtitles?: ReturnType<typeof createSubtitleHandler>;
    plugins?: ReturnType<typeof createPluginRouteHandler>;
    watcher?: ReturnType<typeof createWatcherHandler>;
    jellyfin?: ReturnType<typeof createJellyfinHandler>;
    socket?: ReturnType<typeof createJellyfinSocket>;
  } = {},
): Bun.Server<SocketData> {
  const webRoot = Bun.env.PENDIA_WEB_ROOT ?? defaultWebRoot;

  return Bun.serve<SocketData>({
    port,
    // Without the Jellyfin socket nothing upgrades, so no message arrives.
    websocket: handlers.socket?.websocket ?? { message() {} },
    async fetch(request, server) {
      const { pathname } = new URL(request.url);

      if (pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }

      if (pathname === "/readyz") {
        return (await ready())
          ? Response.json({ status: "ready" })
          : Response.json({ status: "database unavailable" }, { status: 503 });
      }

      if (
        handlers.webhooks &&
        (pathname === "/api/webhooks" || pathname.startsWith("/api/webhooks/"))
      ) {
        const response = await handlers.webhooks(request);
        if (response !== undefined) return response;
      }

      if (handlers.watcher) {
        const response = await handlers.watcher(request);
        if (response !== undefined) return response;
      }

      if (
        handlers.auth &&
        (pathname === "/api/auth" || pathname.startsWith("/api/auth/"))
      ) {
        return handlers.auth(request, server.requestIP(request)?.address ?? "");
      }

      if (handlers.artwork) {
        const response = await handlers.artwork(request);
        if (response !== undefined) return response;
      }

      if (handlers.subtitles) {
        const response = await handlers.subtitles(request);
        if (response !== undefined) return response;
      }

      if (handlers.plugins) {
        const response = await handlers.plugins(
          request,
          server.requestIP(request)?.address ?? "",
        );
        if (response !== undefined) return response;
      }

      if (handlers.socket && pathname.toLowerCase() === socketPath) {
        return handlers.socket.upgrade(request, server);
      }

      if (handlers.jellyfin) {
        const response = await handlers.jellyfin(
          request,
          server.requestIP(request)?.address ?? "",
          server,
        );
        if (response !== undefined) return response;
      }

      if (handlers.api && !isApplicationPath(pathname)) {
        const response = await handlers.api(
          request,
          server.requestIP(request)?.address ?? "",
          server,
        );
        if (response !== undefined) return response;
      }

      if (isApplicationPath(pathname)) {
        return serveWeb(pathname, webRoot);
      }

      return new Response("Not found", { status: 404 });
    },
  });
}
