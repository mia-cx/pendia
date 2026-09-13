import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { sessionRegistry, transcoderCapabilities } from "../db/schema/index.ts";
import { errorResponse, standardHeaders } from "../playback/direct.ts";
import { authorizeHlsRequest, parseHlsPath } from "../playback/hls.ts";
import type { Transcoder } from "../transcoder/index.ts";

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

/** Claims a session for a transcoder node; null when no node is registered. */
async function assignOwner(
  db: Database,
  sessionId: string,
  localNodeId?: string,
) {
  const candidate = localNodeId ?? (await leastLoadedNode(db));
  if (candidate === undefined) return null;
  const [assigned] = await db
    .update(sessionRegistry)
    .set({ transcoderNodeId: candidate })
    .where(
      and(
        eq(sessionRegistry.id, sessionId),
        isNull(sessionRegistry.transcoderNodeId),
      ),
    )
    .returning({ nodeId: sessionRegistry.transcoderNodeId });
  if (assigned !== undefined) return assigned.nodeId;
  // Another api won the claim; read the owner it assigned.
  const [row] = await db
    .select({ nodeId: sessionRegistry.transcoderNodeId })
    .from(sessionRegistry)
    .where(eq(sessionRegistry.id, sessionId))
    .limit(1);
  return row?.nodeId ?? null;
}

/** Creates the HLS route: authenticates, resolves the owning transcoder, serves in-process or proxies. */
export function createHlsHandler(db: Database, local?: Transcoder) {
  return async (
    request: Request,
    server: Bun.Server<undefined>,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const hls = parseHlsPath(url.pathname, "/api/playback");
    if (hls === null) return undefined;
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
      // A segment wait can outlive Bun's default ten second idle timeout.
      server.timeout(request, 30);
      const scope = { sessionId: hls.sessionId, itemId: hls.itemId };
      const { userId, session } = await authorizeHlsRequest(db, url, scope);
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
      let upstream: Response;
      try {
        upstream = await fetch(
          `${node.address}/internal/playback/${hls.sessionId}/${hls.itemId}/hls/${name}${url.search}`,
          { method: request.method, signal: request.signal },
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            role: "api",
            message: "hls.proxy_failed",
            sessionId: hls.sessionId,
            ownerId,
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
    } catch (error) {
      return errorResponse(error);
    }
  };
}
