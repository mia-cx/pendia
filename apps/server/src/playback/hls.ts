import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { verifyPlaybackToken } from "../auth/playback-tokens.ts";
import type { Database } from "../db/client.ts";
import { sessionRegistry } from "../db/schema/index.ts";
import { parseHlsName } from "./playlists.ts";

/** The URL prefixes under which HLS files are served. */
export type HlsPrefix = "/api/playback" | "/internal/playback";

const hlsPaths: Record<HlsPrefix, RegExp> = {
  "/api/playback": /^\/api\/playback\/([^/]+)\/([^/]+)\/hls\/([^/]+)$/,
  "/internal/playback":
    /^\/internal\/playback\/([^/]+)\/([^/]+)\/hls\/([^/]+)$/,
};

/** Parses `<prefix>/{sessionId}/{itemId}/hls/{name}`; null when the path is not an HLS request. */
export function parseHlsPath(pathname: string, prefix: HlsPrefix) {
  const match = hlsPaths[prefix].exec(pathname);
  if (match === null) return null;
  const name = parseHlsName(match[3] ?? "");
  if (name === null) return null;
  return { sessionId: match[1] ?? "", itemId: match[2] ?? "", name };
}

const variantPath =
  /^\/api\/playback\/([^/]+)\/([^/]+)\/hls\/([0-9a-f-]{36})\/([^/]+)$/;

/** Parses `/api/playback/{sessionId}/{itemId}/hls/{versionId}/{name}`, a stored rung's file; null otherwise. */
export function parseVariantHlsPath(pathname: string) {
  const match = variantPath.exec(pathname);
  if (match === null) return null;
  const name = parseHlsName(match[4] ?? "");
  if (name === null || name.kind === "master") return null;
  return {
    sessionId: match[1] ?? "",
    itemId: match[2] ?? "",
    variantId: match[3] ?? "",
    name,
  };
}

/** Verifies the playback token in the URL and loads the live remux or transcode session it names. */
export async function authorizeHlsRequest(
  db: Database,
  url: URL,
  scope: { sessionId: string; itemId: string },
) {
  if (
    !Schema.is(Schema.UUID)(scope.sessionId) ||
    !Schema.is(Schema.UUID)(scope.itemId)
  ) {
    throw new AuthError("UNAUTHENTICATED");
  }
  // Every HLS URL carries its token; there is no cookie fallback here.
  const tokens = url.searchParams.getAll("token");
  const [token] = tokens;
  if (tokens.length !== 1 || token === undefined || token === "") {
    throw new AuthError("UNAUTHENTICATED");
  }
  const claims = await verifyPlaybackToken(db, token, scope);
  const [session] = await db
    .select({
      userId: sessionRegistry.userId,
      versionId: sessionRegistry.versionId,
      playMethod: sessionRegistry.playMethod,
      state: sessionRegistry.state,
      transcoderNodeId: sessionRegistry.transcoderNodeId,
      decision: sessionRegistry.decision,
    })
    .from(sessionRegistry)
    .where(
      and(
        eq(sessionRegistry.id, scope.sessionId),
        eq(sessionRegistry.itemId, scope.itemId),
      ),
    )
    .limit(1);
  if (
    session === undefined ||
    session.userId !== claims.userId ||
    session.playMethod === "direct-play" ||
    session.state === "stopped"
  ) {
    throw new AuthError("UNAUTHENTICATED");
  }
  return { userId: claims.userId, session };
}
