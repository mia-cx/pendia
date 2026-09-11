const defaultPort = 3000;

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

/** Starts the same-origin HTTP server for Pendia's API role. */
export function startApiServer(
  port = readPort(Bun.env.PENDIA_PORT),
): Bun.Server<undefined> {
  return Bun.serve({
    port,
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }

      if (pathname === "/readyz") {
        // Later slices gate readiness on migrations and the transcoder startup trial.
        return Response.json({ status: "ready" });
      }

      return new Response("Not found", { status: 404 });
    },
  });
}
