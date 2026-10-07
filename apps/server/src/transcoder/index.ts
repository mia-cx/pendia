import { mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { eventChannel } from "../api/events.ts";
import { readPort } from "../api.ts";
import type { Database } from "../db/client.ts";
import { events, transcoderCapabilities } from "../db/schema/index.ts";
import { errorResponse, standardHeaders } from "../playback/direct.ts";
import { authorizeHlsRequest, parseHlsPath } from "../playback/hls.ts";
import {
  createSessionManager,
  type SessionManagerOptions,
} from "./sessions.ts";
import { runStartupTrial } from "./trial.ts";

/** Options for the transcoder role; env fills the gaps. */
export type TranscoderOptions = {
  scratchDir?: string; // THALIA_SCRATCH_DIR, else join(tmpdir(), "thalia-scratch")
  port?: number; // THALIA_TRANSCODER_PORT, else 3001
  address?: string; // THALIA_TRANSCODER_URL, else `http://127.0.0.1:${server.port}`
  ready?: () => Promise<boolean>; // answers the Postgres half of /readyz; startThalia passes probeDatabase
  trial?: typeof runStartupTrial; // the startup trial; tests replace it
  transcodeSlots?: number; // THALIA_TRANSCODE_SLOTS, else 2: video re-encodes at once
  idleMs?: number;
  waitMs?: number;
  readRate?: SessionManagerOptions["readRate"];
};

const defaultTranscodeSlots = 2; // the spec's cap for a 12 vCPU node

/** Reads THALIA_TRANSCODE_SLOTS, the per-node cap on concurrent video re-encodes. */
export function readTranscodeSlots() {
  const value = Bun.env.THALIA_TRANSCODE_SLOTS;
  if (value === undefined) return defaultTranscodeSlots;
  const slots = Number(value);
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(
      `THALIA_TRANSCODE_SLOTS must be a positive integer. Found "${value}".`,
    );
  }
  return slots;
}

/** The running transcoder role: its node id, address, session manager and shutdown. */
export type Transcoder = Awaited<ReturnType<typeof startTranscoder>>;

/** Starts the transcoder role: runs the startup trial, registers the node with its capability table, serves /healthz, /readyz and the internal HLS route, and owns live sessions. */
export async function startTranscoder(
  db: Database,
  options: TranscoderOptions = {},
) {
  const scratchDir =
    options.scratchDir ??
    Bun.env.THALIA_SCRATCH_DIR ??
    join(tmpdir(), "thalia-scratch");
  await mkdir(scratchDir, { recursive: true });
  const sessions = createSessionManager(db, {
    scratchDir,
    idleMs: options.idleMs,
    waitMs: options.waitMs,
    readRate: options.readRate,
    transcodeSlots: options.transcodeSlots ?? readTranscodeSlots(),
  });
  const port = options.port ?? readPort("THALIA_TRANSCODER_PORT", 3001);
  let nodeId: string | null = null;
  let stopping: Promise<void> | undefined;

  /** The checks every session route shares: method, token auth and node ownership. */
  const authenticateSession = async (
    request: Request,
    url: URL,
    scope: { sessionId: string; itemId: string },
  ): Promise<
    | {
        userId: string;
        session: Awaited<ReturnType<typeof authorizeHlsRequest>>["session"];
      }
    | Response
  > => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
        },
        {
          status: 405,
          headers: { ...standardHeaders, allow: "GET, HEAD" },
        },
      );
    }
    const { userId, session } = await authorizeHlsRequest(db, url, scope);
    if (session.transcoderNodeId !== nodeId) {
      // The drain released this node's sessions; a request already on its
      // way here retries through the api, which assigns a live node.
      if (stopping !== undefined) {
        return Response.json(
          {
            error: {
              code: "TRANSCODER_STOPPING",
              message: "The transcoder is stopping.",
            },
          },
          {
            status: 503,
            headers: { ...standardHeaders, "retry-after": "1" },
          },
        );
      }
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
    return { userId, session };
  };

  const server = Bun.serve({
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }
      if (url.pathname === "/readyz") {
        if (nodeId === null) {
          return Response.json({ status: "starting" }, { status: 503 });
        }
        // The drain keeps the server up; a balancer must stop routing here.
        if (stopping !== undefined) {
          return Response.json({ status: "stopping" }, { status: 503 });
        }
        const ready = await (options.ready?.() ?? Promise.resolve(true));
        if (stopping !== undefined) {
          return Response.json({ status: "stopping" }, { status: 503 });
        }
        return ready
          ? Response.json({ status: "ready" })
          : Response.json({ status: "database unavailable" }, { status: 503 });
      }
      const streamPath =
        /^\/internal\/playback\/([^/]+)\/([^/]+)\/stream$/.exec(url.pathname);
      const subtitlePath =
        /^\/internal\/playback\/([^/]+)\/([^/]+)\/subtitles\/(\d+)\.vtt$/.exec(
          url.pathname,
        );
      const hls =
        streamPath === null && subtitlePath === null
          ? parseHlsPath(url.pathname, "/internal/playback")
          : null;
      if (streamPath !== null || subtitlePath !== null) {
        try {
          // A paused viewer leaves the stream open and idle for minutes.
          server.timeout(request, 0);
          const scope = {
            sessionId: (streamPath ?? subtitlePath)?.[1] ?? "",
            itemId: (streamPath ?? subtitlePath)?.[2] ?? "",
          };
          const authed = await authenticateSession(request, url, scope);
          if (authed instanceof Response) return authed;
          const { userId, session } = authed;
          if (session.decision?.delivery !== "progressive") {
            return Response.json(
              {
                error: {
                  code: "NOT_FOUND",
                  message: "No progressive stream for this session.",
                },
              },
              { status: 404, headers: standardHeaders },
            );
          }
          const streamScope = {
            ...scope,
            versionId: session.versionId,
            userId,
          };
          if (subtitlePath !== null) {
            return await sessions.streamSubtitle(
              streamScope,
              Number(subtitlePath[3]),
            );
          }
          const start = Number(url.searchParams.get("start") ?? "0");
          return await sessions.stream(
            streamScope,
            Number.isFinite(start) && start >= 0 ? start : 0,
            request.signal,
          );
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (hls === null) {
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Not found." } },
          { status: 404, headers: standardHeaders },
        );
      }
      try {
        // A segment wait can outlive Bun's default ten second idle timeout.
        server.timeout(request, 30);
        const authed = await authenticateSession(request, url, {
          sessionId: hls.sessionId,
          itemId: hls.itemId,
        });
        if (authed instanceof Response) return authed;
        const { userId, session } = authed;
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
    Bun.env.THALIA_TRANSCODER_URL ??
    `http://127.0.0.1:${server.port}`
  ).replace(/\/+$/, "");
  // A client's stop frees its transcode slot at once rather than at the idle
  // timeout. Stops reach every node as session.state events.
  const endStopped = async (payload: string) => {
    if (!/^\d+$/.test(payload)) return;
    const [row] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(eq(events.id, BigInt(payload)), eq(events.kind, "session.state")),
      )
      .limit(1);
    const sessionId = row?.payload.sessionId;
    if (row?.payload.state === "stopped" && typeof sessionId === "string") {
      await sessions.end(sessionId);
    }
  };
  let subscription: Awaited<ReturnType<typeof db.$client.listen>> | undefined;
  let node: { id: string };
  try {
    subscription = await db.$client.listen(eventChannel, (payload) => {
      endStopped(payload).catch((error: unknown) =>
        console.error(
          JSON.stringify({
            level: "error",
            role: "transcoder",
            message: "session.end_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    });
    // /readyz answers starting until the node row exists, so readiness waits
    // for the trial.
    const backends = await (options.trial ?? runStartupTrial)();
    console.info(
      JSON.stringify({
        level: "info",
        role: "transcoder",
        message: "transcoder.trial",
        backends,
      }),
    );
    const [inserted] = await db
      .insert(transcoderCapabilities)
      .values({
        name: hostname(),
        address,
        testedAt: new Date(),
        backends,
      })
      .returning({ id: transcoderCapabilities.id });
    if (!inserted) throw new Error("Transcoder node insert returned no row.");
    node = inserted;
  } catch (error) {
    await subscription?.unlisten().catch(() => {});
    await server.stop();
    throw error;
  }
  nodeId = node.id;
  const listening = subscription;

  return {
    nodeId: node.id,
    address,
    port: server.port,
    sessions,
    /** Removes the node row so new sessions pick another node, then stops sessions and the server, once. */
    stop() {
      stopping ??= (async () => {
        try {
          await db
            .delete(transcoderCapabilities)
            .where(eq(transcoderCapabilities.id, node.id));
        } finally {
          await listening.unlisten().catch(() => {});
          await sessions.stop();
          await server.stop();
        }
      })();
      return stopping;
    },
  };
}
