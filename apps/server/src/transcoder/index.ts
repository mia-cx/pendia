import { mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { readPort } from "../api.ts";
import type { Database } from "../db/client.ts";
import { transcoderCapabilities } from "../db/schema/index.ts";
import { errorResponse, standardHeaders } from "../playback/direct.ts";
import { authorizeHlsRequest, parseHlsPath } from "../playback/hls.ts";
import {
  createSessionManager,
  type SessionManagerOptions,
} from "./sessions.ts";

/** Options for the transcoder role; env fills the gaps. */
export type TranscoderOptions = {
  scratchDir?: string; // PENDIA_SCRATCH_DIR, else join(tmpdir(), "pendia-scratch")
  port?: number; // PENDIA_TRANSCODER_PORT, else 3001
  address?: string; // PENDIA_TRANSCODER_URL, else `http://127.0.0.1:${server.port}`
  idleMs?: number;
  waitMs?: number;
  readRate?: SessionManagerOptions["readRate"];
};

/** The running transcoder role: its node id, address, session manager and shutdown. */
export type Transcoder = Awaited<ReturnType<typeof startTranscoder>>;

/** Starts the transcoder role: registers the node, serves the internal HLS route and owns live sessions. */
export async function startTranscoder(
  db: Database,
  options: TranscoderOptions = {},
) {
  const scratchDir =
    options.scratchDir ??
    Bun.env.PENDIA_SCRATCH_DIR ??
    join(tmpdir(), "pendia-scratch");
  await mkdir(scratchDir, { recursive: true });
  const sessions = createSessionManager(db, {
    scratchDir,
    idleMs: options.idleMs,
    waitMs: options.waitMs,
    readRate: options.readRate,
  });
  const port = options.port ?? readPort("PENDIA_TRANSCODER_PORT", 3001);
  let nodeId: string | null = null;

  const server = Bun.serve({
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }
      const hls = parseHlsPath(url.pathname, "/internal/playback");
      if (hls === null) {
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Not found." } },
          { status: 404, headers: standardHeaders },
        );
      }
      try {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return Response.json(
            {
              error: {
                code: "METHOD_NOT_ALLOWED",
                message: "Method not allowed.",
              },
            },
            {
              status: 405,
              headers: { ...standardHeaders, allow: "GET, HEAD" },
            },
          );
        }
        // A segment wait can outlive Bun's default ten second idle timeout.
        server.timeout(request, 30);
        const { userId, session } = await authorizeHlsRequest(db, url, {
          sessionId: hls.sessionId,
          itemId: hls.itemId,
        });
        if (session.transcoderNodeId !== nodeId) {
          return Response.json(
            {
              error: {
                code: "CONFLICT",
                message: "Session belongs to another transcoder.",
              },
            },
            { status: 409, headers: standardHeaders },
          );
        }
        return await sessions.serve(
          {
            sessionId: hls.sessionId,
            itemId: hls.itemId,
            versionId: session.versionId,
            userId,
          },
          hls.name,
          url.search,
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  });

  const address = (
    options.address ??
    Bun.env.PENDIA_TRANSCODER_URL ??
    `http://127.0.0.1:${server.port}`
  ).replace(/\/+$/, "");
  let node: { id: string };
  try {
    const [inserted] = await db
      .insert(transcoderCapabilities)
      .values({
        name: hostname(),
        address,
        testedAt: new Date(),
        backends: [],
      })
      .returning({ id: transcoderCapabilities.id });
    if (!inserted) throw new Error("Transcoder node insert returned no row.");
    node = inserted;
  } catch (error) {
    await server.stop();
    throw error;
  }
  nodeId = node.id;

  let stopping: Promise<void> | undefined;
  return {
    nodeId: node.id,
    address,
    port: server.port,
    sessions,
    /** Stops sessions and the server, then removes the node row, once. */
    stop() {
      stopping ??= (async () => {
        await sessions.stop();
        await server.stop();
        await db
          .delete(transcoderCapabilities)
          .where(eq(transcoderCapabilities.id, node.id));
      })();
      return stopping;
    },
  };
}
