import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { postgresCode } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { sessionRegistry, transcoderCapabilities } from "../db/schema/index.ts";
import { errorResponse, standardHeaders } from "../playback/direct.ts";
import {
  authorizeHlsRequest,
  parseHlsPath,
  parseVariantHlsPath,
} from "../playback/hls.ts";
import { loadPlaybackSource } from "../playback/planning.ts";
import { serveStoredHls } from "../stored/playback.ts";
import type { Transcoder } from "../transcoder/index.ts";
import { sessionOutputs } from "../transcoder/outputs.ts";

/** The WebVTT renditions a stored session's master lists: the same ones its live session would. */
async function storedSubtitles(
  db: Database,
  userId: string,
  itemId: string,
  session: Awaited<ReturnType<typeof authorizeHlsRequest>>["session"],
) {
  const { source, subtitleDetails } = await loadPlaybackSource(
    db,
    userId,
    itemId,
    session.versionId,
  );
  return sessionOutputs(session.decision, source, subtitleDetails).subtitles;
}

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

const noTranscoder = () =>
  respond(
    {
      error: {
        code: "NO_TRANSCODER",
        message: "No transcoder is available.",
      },
    },
    503,
    { "retry-after": "5" },
  );

async function leastLoadedNode(db: Database) {
  const [row] = await db
    .select({ id: transcoderCapabilities.id })
    .from(transcoderCapabilities)
    .leftJoin(
      sessionRegistry,
      eq(sessionRegistry.transcoderNodeId, transcoderCapabilities.id),
    )
    .groupBy(transcoderCapabilities.id)
    .orderBy(
      sql`count(${sessionRegistry.id}) filter (where ${sessionRegistry.state} <> 'stopped')`,
      asc(transcoderCapabilities.id),
    )
    .limit(1);
  return row?.id;
}

/** Claims a session for a transcoder node; null when no node is registered or the node was removed mid-claim. */
async function assignOwner(
  db: Database,
  sessionId: string,
  localNodeId?: string,
) {
  const candidate = localNodeId ?? (await leastLoadedNode(db));
  if (candidate === undefined) return null;
  let assigned: { nodeId: string | null } | undefined;
  try {
    [assigned] = await db
      .update(sessionRegistry)
      .set({ transcoderNodeId: candidate })
      .where(
        and(
          eq(sessionRegistry.id, sessionId),
          isNull(sessionRegistry.transcoderNodeId),
        ),
      )
      .returning({ nodeId: sessionRegistry.transcoderNodeId });
  } catch (error) {
    if (postgresCode(error) === "23503") return null;
    throw error;
  }
  if (assigned !== undefined) return assigned.nodeId;
  // Another api won the claim; read the owner it assigned.
  const [row] = await db
    .select({ nodeId: sessionRegistry.transcoderNodeId })
    .from(sessionRegistry)
    .where(eq(sessionRegistry.id, sessionId))
    .limit(1);
  return row?.nodeId ?? null;
}

const progressiveStreamPath = /^\/api\/playback\/([^/]+)\/([^/]+)\/stream$/;
const progressiveSubtitlePath =
  /^\/api\/playback\/([^/]+)\/([^/]+)\/subtitles\/(\d+)\.vtt$/;

/** Proxies a playback request to the session's owning node, copying the headers a caller needs. */
async function proxyToNode(
  node: { address: string },
  internalPath: string,
  request: Request,
) {
  let upstream: Response;
  try {
    upstream = await fetch(`${node.address}${internalPath}`, {
      method: request.method,
      signal: request.signal,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        role: "api",
        message: "hls.proxy_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return respond(
      {
        error: {
          code: "TRANSCODER_UNREACHABLE",
          message: "The transcoder for this session is unreachable.",
        },
      },
      503,
      { "retry-after": "1" },
    );
  }
  const headers = new Headers(standardHeaders);
  for (const header of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "retry-after",
    "allow",
  ]) {
    const value = upstream.headers.get(header);
    if (value !== null) headers.set(header, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

/** Creates the playback media route: authenticates, resolves the owning transcoder, serves in-process or proxies. */
export function createHlsHandler(db: Database, local?: Transcoder) {
  return async (
    request: Request,
    server: Pick<Bun.Server<undefined>, "timeout">,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const streamPath = progressiveStreamPath.exec(url.pathname);
    const apiSubtitlePath = progressiveSubtitlePath.exec(url.pathname);
    const variant =
      streamPath === null && apiSubtitlePath === null
        ? parseVariantHlsPath(url.pathname)
        : null;
    const hls =
      variant ??
      (streamPath === null && apiSubtitlePath === null
        ? parseHlsPath(url.pathname, "/api/playback")
        : null);
    if (hls === null && streamPath === null && apiSubtitlePath === null)
      return undefined;
    const progressive = streamPath !== null || apiSubtitlePath !== null;
    const scope = {
      sessionId:
        streamPath?.[1] ?? apiSubtitlePath?.[1] ?? hls?.sessionId ?? "",
      itemId: streamPath?.[2] ?? apiSubtitlePath?.[2] ?? hls?.itemId ?? "",
    };
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
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
      }
      // A segment wait can outlive Bun's default ten second idle timeout; a
      // paused progressive stream stays open and idle for minutes.
      server.timeout(request, streamPath !== null ? 0 : 30);
      const { userId, session } = await authorizeHlsRequest(db, url, scope);
      if (progressive) {
        if (session.decision?.delivery !== "progressive") {
          return respond(
            { error: { code: "NOT_FOUND", message: "Not found." } },
            404,
          );
        }
      } else if (session.decision?.delivery === "progressive") {
        // A progressive session's media lives on the stream route, not HLS.
        return respond(
          { error: { code: "NOT_FOUND", message: "Not found." } },
          404,
        );
      }
      if (progressive) {
        const ownerId =
          session.transcoderNodeId ??
          (await assignOwner(db, scope.sessionId, local?.nodeId));
        if (ownerId === null) return noTranscoder();
        if (local !== undefined && ownerId === local.nodeId) {
          const streamScope = {
            ...scope,
            versionId: session.versionId,
            userId,
          };
          if (apiSubtitlePath !== null) {
            return await local.sessions.streamSubtitle(
              streamScope,
              Number(apiSubtitlePath[3]),
            );
          }
          const start = Number(url.searchParams.get("start") ?? "0");
          if (!Number.isFinite(start) || start < 0) {
            return respond(
              { error: { code: "INVALID_INPUT", message: "Invalid start." } },
              400,
            );
          }
          return await local.sessions.stream(
            streamScope,
            start,
            request.signal,
          );
        }
        const [node] = await db
          .select({ address: transcoderCapabilities.address })
          .from(transcoderCapabilities)
          .where(eq(transcoderCapabilities.id, ownerId))
          .limit(1);
        if (node === undefined) return noTranscoder();
        return await proxyToNode(
          node,
          `/internal/playback/${scope.sessionId}/${scope.itemId}/${
            apiSubtitlePath !== null
              ? `subtitles/${apiSubtitlePath[3]}.vtt`
              : "stream"
          }${url.search}`,
          request,
        );
      }
      // Progressive paths returned above; what is left is an HLS request.
      if (hls === null)
        return respond(
          { error: { code: "NOT_FOUND", message: "Not found." } },
          404,
        );
      // Stored rungs live on the library share, which the api reads itself.
      // Their subtitles do not: those come from the transcoder like a live
      // session's, so subtitle requests fall through to it.
      const variantIds = session.decision?.storedVariantIds ?? [];
      const subtitleRequest =
        hls.name.kind === "subtitles" || hls.name.kind === "subtitle";
      if (variantIds.length > 0 && (variant !== null || !subtitleRequest))
        return await serveStoredHls(
          db,
          { itemId: hls.itemId, variantIds },
          variant?.variantId ?? null,
          hls.name,
          url.search,
          hls.name.kind === "master"
            ? await storedSubtitles(db, userId, hls.itemId, session)
            : [],
        );
      if (variant !== null)
        return respond(
          { error: { code: "NOT_FOUND", message: "Not found." } },
          404,
        );
      const ownerId =
        session.transcoderNodeId ??
        (await assignOwner(db, hls.sessionId, local?.nodeId));
      if (ownerId === null) return noTranscoder();
      if (local !== undefined && ownerId === local.nodeId) {
        return await local.sessions.serve(
          {
            sessionId: hls.sessionId,
            itemId: hls.itemId,
            versionId: session.versionId,
            userId,
          },
          hls.name,
          url.search,
        );
      }
      const [node] = await db
        .select({ address: transcoderCapabilities.address })
        .from(transcoderCapabilities)
        .where(eq(transcoderCapabilities.id, ownerId))
        .limit(1);
      if (node === undefined) return noTranscoder();
      const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      return await proxyToNode(
        node,
        `/internal/playback/${hls.sessionId}/${hls.itemId}/hls/${name}${url.search}`,
        request,
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}
