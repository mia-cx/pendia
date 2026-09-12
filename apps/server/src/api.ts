import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { createApiHandler } from "./api/handler.ts";
import type { createAuthHandler } from "./auth/http.ts";

const defaultPort = 3000;
const defaultWebRoot = fileURLToPath(
  new URL("../../web/build/", import.meta.url),
);

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return defaultPort;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `PENDIA_PORT must be an integer from 1 to 65535. Found "${value}".`,
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
  port = readPort(Bun.env.PENDIA_PORT),
  handlers: {
    auth?: ReturnType<typeof createAuthHandler>;
    api?: ReturnType<typeof createApiHandler>;
  } = {},
): Bun.Server<undefined> {
  const webRoot = Bun.env.PENDIA_WEB_ROOT ?? defaultWebRoot;

  return Bun.serve({
    port,
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
        handlers.auth &&
        (pathname === "/api/auth" || pathname.startsWith("/api/auth/"))
      ) {
        return handlers.auth(request, server.requestIP(request)?.address ?? "");
      }

      if (handlers.api && !isApplicationPath(pathname)) {
        const response = await handlers.api(
          request,
          server.requestIP(request)?.address ?? "",
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
