import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { checkOrigin, readSessionToken } from "../auth/http.ts";
import { verifyPlaybackToken } from "../auth/playback-tokens.ts";
import { authenticate } from "../auth/sessions.ts";
import { readAuthSettings } from "../auth/settings.ts";
import { requestIdentity } from "../auth/transport.ts";
import type { Database } from "../db/client.ts";
import { libraries, sessionRegistry } from "../db/schema/index.ts";
import { type LibraryFile, readLibraryFile } from "../libraries/walker.ts";
import { loadPlaybackSource } from "./planning.ts";

const directPath = /^\/api\/playback\/([^/]+)\/([^/]+)\/direct$/;

/** Headers every playback and HLS response carries. */
export const standardHeaders: Record<string, string> = {
  "cache-control": "no-store",
  vary: "cookie, authorization",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function respond(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: { ...standardHeaders, ...headers },
  });
}

/** Turns an auth failure into its JSON response; anything else is a logged 500. */
export function errorResponse(error: unknown): Response {
  if (error instanceof AuthError)
    return respond(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  console.error(
    JSON.stringify({ level: "error", message: "playback.request.failed" }),
  );
  return respond(
    { error: { code: "INTERNAL_ERROR", message: "Playback request failed." } },
    500,
  );
}

async function requestUserId(
  db: Database,
  request: Request,
  peerAddress: string,
  scope: { sessionId: string; itemId: string },
  url: URL,
): Promise<string> {
  const tokens = url.searchParams.getAll("token");
  if (tokens.length > 0) {
    const [token] = tokens;
    if (tokens.length !== 1 || token === undefined || token === "")
      throw new AuthError("UNAUTHENTICATED");
    const claims = await verifyPlaybackToken(db, token, scope);
    return claims.userId;
  }
  if (request.headers.get("authorization") !== null)
    throw new AuthError("UNAUTHENTICATED");
  const caller = await authenticate(db, readSessionToken(request));
  if (caller.credential.kind !== "session")
    throw new AuthError("UNAUTHENTICATED");
  const config = await readAuthSettings(db);
  const identity = requestIdentity(
    request,
    peerAddress,
    config.trustedProxyAddresses,
  );
  checkOrigin(request, identity.secure);
  return caller.user.id;
}

/** Creates the direct-play file handler matched ahead of the API router. */
export function createDirectPlayHandler(db: Database) {
  return async (
    request: Request,
    peerAddress: string,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const match = directPath.exec(url.pathname);
    if (match === null) return undefined;
    try {
      if (request.method !== "GET" && request.method !== "HEAD")
        return respond(
          {
            error: {
              code: "METHOD_NOT_ALLOWED",
              message: "Method not allowed.",
            },
          },
          405,
          { allow: "GET, HEAD" },
        );
      const sessionId = match[1] ?? "";
      const itemId = match[2] ?? "";
      if (!Schema.is(Schema.UUID)(sessionId) || !Schema.is(Schema.UUID)(itemId))
        throw new AuthError("UNAUTHENTICATED");
      const userId = await requestUserId(
        db,
        request,
        peerAddress,
        {
          sessionId,
          itemId,
        },
        url,
      );
      const [session] = await db
        .select({
          userId: sessionRegistry.userId,
          versionId: sessionRegistry.versionId,
          playMethod: sessionRegistry.playMethod,
          state: sessionRegistry.state,
        })
        .from(sessionRegistry)
        .where(
          and(
            eq(sessionRegistry.id, sessionId),
            eq(sessionRegistry.itemId, itemId),
          ),
        )
        .limit(1);
      if (
        session === undefined ||
        session.userId !== userId ||
        session.state === "stopped" ||
        session.playMethod !== "direct-play"
      )
        throw new AuthError("UNAUTHENTICATED");
      const { item, file } = await loadPlaybackSource(
        db,
        userId,
        itemId,
        session.versionId,
      );
      const [library] = await db
        .select({ rootPath: libraries.rootPath })
        .from(libraries)
        .where(eq(libraries.id, item.libraryId))
        .limit(1);
      if (library === undefined) throw new AuthError("NOT_FOUND");
      let validated: LibraryFile;
      try {
        validated = await readLibraryFile(library.rootPath, file.path);
      } catch {
        return respond(
          {
            error: {
              code: "NOT_FOUND",
              message: "Playback file not found.",
            },
          },
          404,
        );
      }
      const headers = new Headers(standardHeaders);
      headers.set("accept-ranges", "bytes");
      return new Response(Bun.file(resolve(library.rootPath, validated.path)), {
        headers,
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
