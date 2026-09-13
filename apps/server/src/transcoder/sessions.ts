import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { libraries, segmentTimelines } from "../db/schema/index.ts";
import { readLibraryFile } from "../libraries/walker.ts";
import { standardHeaders } from "../playback/direct.ts";
import {
  decideSegment,
  initialState,
  type LiveState,
  runEnded,
  runStarted,
  type SegmentDecision,
  segmentsReady,
} from "../playback/live-session.ts";
import { loadPlaybackSource } from "../playback/planning.ts";
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  codecString,
  type HlsName,
  type PlaylistVariant,
  segmentCount,
} from "../playback/playlists.ts";
import { type RemuxRun, type RunHandle, startRemuxRun } from "./remux.ts";

/** The authorised session a request belongs to. */
export type SessionScope = {
  sessionId: string;
  itemId: string;
  versionId: string;
  userId: string;
};

/** Options for a session manager; timeouts are injectable for tests. */
export type SessionManagerOptions = {
  scratchDir: string; // created if missing
  idleMs?: number; // default 60_000
  waitMs?: number; // default 20_000
  readRate?: RemuxRun["readRate"]; // passed to every run; tests only
};

/** Holds the live remux sessions of one transcoder: processes, scratch and ready events. */
export type SessionManager = ReturnType<typeof createSessionManager>;

type Waiter = (ok: boolean) => void;

type LiveSession = {
  scope: SessionScope;
  directory: string;
  inputPath: string;
  boundariesSeconds: readonly number[];
  variant: PlaylistVariant;
  state: LiveState;
  paths: Map<number, string>;
  init: Uint8Array | null;
  initWaiters: Set<Waiter>;
  segmentWaiters: Map<number, Set<Waiter>>;
  runs: number;
  current: { handle: RunHandle; startIndex: number } | null;
  transition: Promise<void>;
  publishes: Set<Promise<unknown>>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
};

const log = (
  level: "info" | "error",
  message: string,
  data: Record<string, unknown> = {},
) => {
  const line = JSON.stringify({
    level,
    role: "transcoder",
    message,
    ...data,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.info(line);
  }
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Creates the manager that owns ffmpeg processes and scratch for live sessions. */
export function createSessionManager(
  db: Database,
  options: SessionManagerOptions,
) {
  const scratchDir = options.scratchDir;
  const idleMs = options.idleMs ?? 60_000;
  const waitMs = options.waitMs ?? 20_000;
  const readRate = options.readRate;
  const sessions = new Map<string, Promise<LiveSession>>();

  const playlist = (body: string) =>
    new Response(body, {
      headers: {
        ...standardHeaders,
        "content-type": "application/vnd.apple.mpegurl",
      },
    });

  const notReady = () =>
    Response.json(
      {
        error: {
          code: "SEGMENT_NOT_READY",
          message: "Segment is not ready yet.",
        },
      },
      {
        status: 503,
        headers: { ...standardHeaders, "retry-after": "1" },
      },
    );

  const segmentNotFound = () =>
    Response.json(
      { error: { code: "NOT_FOUND", message: "Segment not found." } },
      { status: 404, headers: standardHeaders },
    );

  const serveSegmentFile = (session: LiveSession, index: number) => {
    const path = session.paths.get(index);
    if (path === undefined) return notReady();
    return new Response(Bun.file(path), {
      headers: { ...standardHeaders, "content-type": "video/iso.segment" },
    });
  };

  const serveInit = (session: LiveSession) => {
    if (session.init === null) return notReady();
    return new Response(session.init.slice(), {
      headers: { ...standardHeaders, "content-type": "video/mp4" },
    });
  };

  const count = (session: LiveSession) =>
    segmentCount(session.boundariesSeconds);

  const resolveWaiters = (session: LiveSession, index: number) => {
    const waiters = session.segmentWaiters.get(index);
    session.segmentWaiters.delete(index);
    for (const waiter of waiters ?? []) {
      waiter(true);
    }
  };

  const rejectWaiters = (session: LiveSession) => {
    for (const waiters of session.segmentWaiters.values()) {
      for (const waiter of waiters) {
        waiter(false);
      }
    }
    session.segmentWaiters.clear();
    for (const waiter of session.initWaiters) {
      waiter(false);
    }
    session.initWaiters.clear();
  };

  const onReady = (
    session: LiveSession,
    handle: RunHandle,
    directory: string,
    indexes: number[],
  ) => {
    if (session.stopped) return;
    // A late event from a killed run still describes complete segments but
    // must not move the current run's frontier.
    session.state = segmentsReady(
      session.state,
      indexes,
      session.current?.handle === handle,
    );
    for (const index of indexes) {
      session.paths.set(index, join(directory, `${index}.m4s`));
    }
    if (session.init === null) {
      void (async () => {
        const bytes = await Bun.file(join(directory, "init.mp4"))
          .arrayBuffer()
          .catch(() => null);
        if (bytes === null || session.init !== null) return;
        session.init = new Uint8Array(bytes);
        for (const waiter of session.initWaiters) {
          waiter(true);
        }
        session.initWaiters.clear();
      })();
    }
    for (const index of indexes) {
      resolveWaiters(session, index);
    }
    for (const index of indexes) {
      const published = publishEvent(db, {
        kind: "segment.ready",
        sessionId: session.scope.sessionId,
        index,
      }).catch((error: unknown) => {
        log("error", "segment.ready.publish_failed", {
          sessionId: session.scope.sessionId,
          index,
          error: errorMessage(error),
        });
      });
      session.publishes.add(published);
      void published.finally(() => session.publishes.delete(published));
    }
  };

  const onExit = (
    session: LiveSession,
    handle: RunHandle,
    directory: string,
    code: number | null,
  ) => {
    // A run superseded by a restart or a stop is cleaned up by its killer.
    if (session.current?.handle !== handle) return;
    const startIndex = session.current.startIndex;
    session.current = null;
    session.state = runEnded(session.state, code === 0, count(session));
    if (code === 0) {
      for (let index = startIndex; index < count(session); index += 1) {
        session.paths.set(index, join(directory, `${index}.m4s`));
        resolveWaiters(session, index);
      }
    } else {
      rejectWaiters(session);
    }
  };

  const startRun = async (session: LiveSession, index: number) => {
    session.runs += 1;
    const directory = join(session.directory, `run-${session.runs}`);
    await mkdir(directory, { recursive: true });
    const handle = startRemuxRun(
      {
        inputPath: session.inputPath,
        boundariesSeconds: session.boundariesSeconds,
        startIndex: index,
        directory,
        readRate,
      },
      (indexes) => onReady(session, handle, directory, indexes),
    );
    if (session.stopped) {
      // A stop drained the transition while this start was in flight.
      await handle.kill();
      return;
    }
    session.state = runStarted(session.state, index);
    session.current = { handle, startIndex: index };
    handle.exited
      .then((code) => onExit(session, handle, directory, code))
      .catch((error: unknown) =>
        log("error", "remux.exit_failed", {
          sessionId: session.scope.sessionId,
          error: errorMessage(error),
        }),
      );
  };

  const ensureStarted = (session: LiveSession) => {
    session.transition = session.transition.then(async () => {
      if (session.state.run !== null || session.state.ready.size > 0) return;
      await startRun(session, 0);
    });
    return session.transition;
  };

  const restartAt = (session: LiveSession, index: number) => {
    session.transition = session.transition.then(async () => {
      const run = session.current;
      session.current = null;
      if (run !== null) {
        await run.handle.kill();
        session.state = runEnded(session.state, false, count(session));
      }
      await startRun(session, index);
    });
    return session.transition;
  };

  const loadSession = async (scope: SessionScope): Promise<LiveSession> => {
    const directory = join(scratchDir, scope.sessionId);
    const { item, version, file, source } = await loadPlaybackSource(
      db,
      scope.userId,
      scope.itemId,
      scope.versionId,
    );
    const [library] = await db
      .select({ rootPath: libraries.rootPath })
      .from(libraries)
      .where(eq(libraries.id, item.libraryId))
      .limit(1);
    if (library === undefined) throw new AuthError("NOT_FOUND");
    let inputPath: string;
    try {
      const validated = await readLibraryFile(library.rootPath, file.path);
      inputPath = resolve(library.rootPath, validated.path);
    } catch {
      throw new AuthError("NOT_FOUND");
    }
    if (version.segmentTimelineId === null || !version.timelineAligned) {
      throw new AuthError("CONFLICT");
    }
    const [timeline] = await db
      .select({ boundariesSeconds: segmentTimelines.boundariesSeconds })
      .from(segmentTimelines)
      .where(eq(segmentTimelines.id, version.segmentTimelineId))
      .limit(1);
    if (timeline === undefined) throw new AuthError("CONFLICT");
    const audio = source.audio[0];
    const variant: PlaylistVariant = {
      bandwidth: Math.round(source.video.bitrate),
      width: source.video.width,
      height: source.video.height,
      codecs: [
        codecString({
          codec: source.video.codec,
          profile: source.video.profile ?? null,
          level: source.video.level ?? null,
        }),
        ...(audio === undefined
          ? []
          : [codecString({ codec: audio.codec, profile: null, level: null })]),
      ].filter((codec) => codec !== null),
    };
    return {
      scope,
      directory,
      inputPath,
      boundariesSeconds: timeline.boundariesSeconds,
      variant,
      state: initialState,
      paths: new Map(),
      init: null,
      initWaiters: new Set(),
      segmentWaiters: new Map(),
      runs: 0,
      current: null,
      transition: Promise.resolve(),
      publishes: new Set(),
      idleTimer: null,
      stopped: false,
    };
  };

  const liveSession = (scope: SessionScope) => {
    const existing = sessions.get(scope.sessionId);
    if (existing !== undefined) return existing;
    const pending = loadSession(scope);
    sessions.set(scope.sessionId, pending);
    pending.catch(() => {
      if (sessions.get(scope.sessionId) === pending) {
        sessions.delete(scope.sessionId);
      }
    });
    return pending;
  };

  const touch = (session: LiveSession) => {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void stopSession(session.scope.sessionId, "idle").catch(
        (error: unknown) =>
          log("error", "session.stop_failed", {
            sessionId: session.scope.sessionId,
            error: errorMessage(error),
          }),
      );
    }, idleMs);
  };

  const waitForSegment = (
    session: LiveSession,
    index: number,
  ): Promise<Response> =>
    new Promise<Response>((resolvePromise) => {
      const waiters = session.segmentWaiters.get(index) ?? new Set<Waiter>();
      session.segmentWaiters.set(index, waiters);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolvePromise(ok ? serveSegmentFile(session, index) : notReady());
      };
      const timer = setTimeout(() => finish(false), waitMs);
      waiters.add(finish);
    });

  const waitForInit = (session: LiveSession): Promise<Response> =>
    new Promise<Response>((resolvePromise) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        session.initWaiters.delete(finish);
        resolvePromise(ok ? serveInit(session) : notReady());
      };
      const timer = setTimeout(() => finish(false), waitMs);
      session.initWaiters.add(finish);
    });

  const serveSegmentRequest = async (session: LiveSession, index: number) => {
    const segments = count(session);
    let decision: SegmentDecision;
    try {
      decision = decideSegment(session.state, index, segments);
    } catch (error) {
      if (error instanceof RangeError) return segmentNotFound();
      throw error;
    }
    if (decision.action === "serve") return serveSegmentFile(session, index);
    if (decision.action === "wait") return waitForSegment(session, index);
    await restartAt(session, index);
    const again = decideSegment(session.state, index, segments);
    if (again.action === "serve") return serveSegmentFile(session, index);
    if (again.action === "wait") return waitForSegment(session, index);
    // A concurrent caller moved the run; restart once more, then wait.
    await restartAt(session, again.index);
    return waitForSegment(session, index);
  };

  const serveInitRequest = async (session: LiveSession) => {
    if (session.init !== null) return serveInit(session);
    await ensureStarted(session);
    if (session.init !== null) return serveInit(session);
    return waitForInit(session);
  };

  const stopSession = async (
    sessionId: string,
    reason: "idle" | "shutdown",
  ) => {
    const pending = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (pending === undefined) return;
    const session = await pending.catch(() => null);
    if (session === null) return;
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.stopped = true;
    await session.transition.catch(() => {});
    await session.current?.handle.kill();
    rejectWaiters(session);
    await Promise.allSettled(session.publishes);
    await rm(session.directory, { recursive: true, force: true });
    log("info", "session.stopped", { sessionId, reason });
  };

  return {
    async serve(
      scope: SessionScope,
      name: HlsName,
      query: string,
    ): Promise<Response> {
      const session = await liveSession(scope);
      touch(session);
      if (name.kind === "master" || name.kind === "media") {
        await ensureStarted(session);
        return playlist(
          name.kind === "master"
            ? buildMasterPlaylist(session.variant, query)
            : buildMediaPlaylist(session.boundariesSeconds, query),
        );
      }
      if (name.kind === "init") return serveInitRequest(session);
      return serveSegmentRequest(session, name.index);
    },
    async inspect(sessionId: string) {
      const session = await sessions.get(sessionId)?.catch(() => null);
      if (session === null || session === undefined) return undefined;
      return {
        runs: session.runs,
        running: session.current !== null,
        pid: session.current?.handle.pid ?? null,
        ready: [...session.state.ready].sort((a, b) => a - b),
      };
    },
    async stop() {
      await Promise.all(
        [...sessions.keys()].map((sessionId) =>
          stopSession(sessionId, "shutdown"),
        ),
      );
    },
  };
}
