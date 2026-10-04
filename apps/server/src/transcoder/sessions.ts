import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  libraries,
  segmentTimelines,
  sessionRegistry,
} from "../db/schema/index.ts";
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
  buildSubtitlePlaylist,
  type HlsName,
  segmentCount,
} from "../playback/playlists.ts";
import {
  type LiveRun,
  type ReadySegment,
  type RunHandle,
  startLiveRun,
} from "./live-run.ts";
import { type SessionOutputs, sessionOutputs } from "./outputs.ts";
import { type Conversion, convertToWebvtt } from "./subtitles.ts";

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
  readRate?: LiveRun["readRate"]; // passed to every run; tests only
  transcodeSlots?: number; // video re-encodes at once, default 2; later ones queue
};

/** Holds the live sessions of one transcoder: processes, scratch and ready events. */
export type SessionManager = ReturnType<typeof createSessionManager>;

type Waiter = (ok: boolean) => void;

type LiveSession = {
  scope: SessionScope;
  directory: string;
  inputPath: string;
  boundariesSeconds: readonly number[];
  outputs: SessionOutputs;
  /** WebVTT conversions by subtitle Stream index, started on first request. */
  conversions: Map<number, Conversion>;
  state: LiveState;
  segments: Map<number, { path: string; fragmentOffset: number }>;
  init: Uint8Array | null;
  initWaiters: Set<Waiter>;
  segmentWaiters: Map<number, Set<Waiter>>;
  runs: number;
  current: { handle: RunHandle; startIndex: number } | null;
  transition: Promise<void>;
  publishes: Set<Promise<unknown>>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** Waiting for a transcode slot; init and segment requests wait with it. */
  queued: boolean;
  admissionWaiters: Set<Waiter>;
  /** Registry state writes, in order, so a promotion never lands before its queueing. */
  registryWrites: Promise<void>;
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
  const transcodeSlots = options.transcodeSlots ?? 2;
  const sessions = new Map<string, Promise<LiveSession>>();
  const stopping = new Map<string, Promise<void>>();
  // Session ids holding a transcode slot, and the sessions waiting for one in arrival order.
  const admitted = new Set<string>();
  const queue: LiveSession[] = [];
  let closed = false;

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
    const segment = session.segments.get(index);
    if (segment === undefined) return notReady();
    // The file opens with its own init; only the fragment goes out.
    return new Response(Bun.file(segment.path).slice(segment.fragmentOffset), {
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
    ready: ReadySegment[],
  ) => {
    if (session.stopped) return;
    const indexes = ready.map((segment) => segment.index);
    // A late event from a killed run still describes complete segments but
    // must not move the current run's frontier.
    session.state = segmentsReady(
      session.state,
      indexes,
      session.current?.handle === handle,
    );
    for (const { index, fragmentOffset } of ready) {
      session.segments.set(index, {
        path: join(directory, `${index}.m4s`),
        fragmentOffset,
      });
    }
    const [first] = ready;
    if (session.init === null && first !== undefined) {
      // Every run writes the same init; the session keeps the first one.
      void (async () => {
        const bytes = await Bun.file(join(directory, `${first.index}.m4s`))
          .slice(0, first.fragmentOffset)
          .bytes()
          .catch(() => null);
        if (bytes === null || session.init !== null) return;
        session.init = bytes;
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

  const onExit = (session: LiveSession, handle: RunHandle) => {
    // A run superseded by a restart or a stop is cleaned up by its killer.
    if (session.current?.handle !== handle) return;
    session.current = null;
    session.state = runEnded(session.state);
    // Every written segment was reported through the final list; a waiter
    // left here asked for one this run never wrote.
    rejectWaiters(session);
  };

  const startRun = async (session: LiveSession, index: number) => {
    // A transition queued after the stop must not recreate scratch.
    if (session.stopped) return;
    session.runs += 1;
    const directory = join(session.directory, `run-${session.runs}`);
    await mkdir(directory, { recursive: true });
    const handle = startLiveRun(
      {
        inputPath: session.inputPath,
        boundariesSeconds: session.boundariesSeconds,
        startIndex: index,
        directory,
        video: session.outputs.video,
        audio: session.outputs.audio,
        burnSubtitle: session.outputs.burnSubtitle,
        readRate,
      },
      (ready) => onReady(session, handle, directory, ready),
    );
    if (session.stopped) {
      // A stop drained the transition while this start was in flight.
      await handle.kill();
      return;
    }
    session.state = runStarted(session.state, index);
    session.current = { handle, startIndex: index };
    handle.exited
      .then(() => onExit(session, handle))
      .catch((error: unknown) =>
        log("error", "run.exit_failed", {
          sessionId: session.scope.sessionId,
          error: errorMessage(error),
        }),
      );
  };

  const ensureStarted = (session: LiveSession) => {
    const next = session.transition.then(async () => {
      if (session.state.run !== null || session.state.ready.size > 0) return;
      await startRun(session, 0);
    });
    // The caller sees the failure; the queue does not stay poisoned by it.
    session.transition = next.catch(() => {});
    return next;
  };

  const restartAt = (session: LiveSession, index: number) => {
    const next = session.transition.then(async () => {
      // A transition ahead in the queue may have moved the run; decide again
      // on the state it left behind so parallel seeks restart once.
      const decision = decideSegment(session.state, index, count(session));
      if (decision.action !== "restart") return;
      const run = session.current;
      session.current = null;
      if (run !== null) {
        await run.handle.kill();
        session.state = runEnded(session.state);
      }
      // The new run starts at the seek. Waiters behind it get their 503 now, not at waitMs.
      for (const [waiting, waiters] of session.segmentWaiters) {
        if (waiting >= index) continue;
        session.segmentWaiters.delete(waiting);
        for (const waiter of waiters) {
          waiter(false);
        }
      }
      await startRun(session, index);
    });
    // The caller sees the failure; the queue does not stay poisoned by it.
    session.transition = next.catch(() => {});
    return next;
  };

  const loadSession = async (scope: SessionScope): Promise<LiveSession> => {
    const directory = join(scratchDir, scope.sessionId);
    const { item, version, file, source, subtitleDetails } =
      await loadPlaybackSource(db, scope.userId, scope.itemId, scope.versionId);
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
    const [row] = await db
      .select({ decision: sessionRegistry.decision })
      .from(sessionRegistry)
      .where(eq(sessionRegistry.id, scope.sessionId))
      .limit(1);
    const outputs = sessionOutputs(row?.decision, source, subtitleDetails);
    // A copy cuts on the Version's keyframes and a re-encode restarts on the
    // frame at a boundary; both need the Version's frames on the timeline.
    if (version.segmentTimelineId === null || !version.timelineAligned) {
      throw new AuthError("CONFLICT");
    }
    const [timeline] = await db
      .select({ boundariesSeconds: segmentTimelines.boundariesSeconds })
      .from(segmentTimelines)
      .where(eq(segmentTimelines.id, version.segmentTimelineId))
      .limit(1);
    if (timeline === undefined) throw new AuthError("CONFLICT");
    return {
      scope,
      directory,
      inputPath,
      boundariesSeconds: timeline.boundariesSeconds,
      outputs,
      conversions: new Map(),
      state: initialState,
      segments: new Map(),
      init: null,
      initWaiters: new Set(),
      segmentWaiters: new Map(),
      runs: 0,
      current: null,
      transition: Promise.resolve(),
      publishes: new Set(),
      idleTimer: null,
      stopped: false,
      queued: false,
      admissionWaiters: new Set(),
      registryWrites: Promise.resolve(),
    };
  };

  // Moves the registry state the client sees, only from the expected state,
  // so a stop or a start the client made in between wins. The row and its
  // event commit together, so nobody reads the state without its event.
  const recordState = (
    session: LiveSession,
    from: "starting" | "queued",
    to: "starting" | "queued",
  ) => {
    const { sessionId } = session.scope;
    session.registryWrites = session.registryWrites
      .then(() =>
        db.transaction(async (tx) => {
          const moved = await tx
            .update(sessionRegistry)
            .set({ state: to })
            .where(
              and(
                eq(sessionRegistry.id, sessionId),
                eq(sessionRegistry.state, from),
              ),
            )
            .returning({ id: sessionRegistry.id });
          if (moved.length > 0) {
            await publishEvent(tx, {
              kind: "session.state",
              sessionId,
              state: to,
            });
          }
        }),
      )
      .catch((error: unknown) =>
        log("error", "session.state_failed", {
          sessionId,
          state: to,
          error: errorMessage(error),
        }),
      );
  };

  /** Takes a transcode slot for a session that re-encodes video, or queues it. */
  const requestSlot = (session: LiveSession) => {
    if (session.outputs.video.action !== "transcode") return;
    const { sessionId } = session.scope;
    if (admitted.size < transcodeSlots) {
      admitted.add(sessionId);
      // A session that queued, idled out and revives into a free slot still
      // reads queued in the registry; the client's start needs starting.
      recordState(session, "queued", "starting");
      return;
    }
    session.queued = true;
    queue.push(session);
    log("info", "session.queued", { sessionId, position: queue.length });
    recordState(session, "starting", "queued");
  };

  /** Hands freed slots to queued sessions in arrival order. */
  const admitNext = () => {
    while (!closed && admitted.size < transcodeSlots) {
      const next = queue.shift();
      if (next === undefined) return;
      if (next.stopped) continue;
      admitted.add(next.scope.sessionId);
      next.queued = false;
      for (const waiter of next.admissionWaiters) {
        waiter(true);
      }
      next.admissionWaiters.clear();
      log("info", "session.admitted", { sessionId: next.scope.sessionId });
      recordState(next, "queued", "starting");
    }
  };

  const releaseSlot = (session: LiveSession) => {
    const position = queue.indexOf(session);
    if (position >= 0) queue.splice(position, 1);
    if (admitted.delete(session.scope.sessionId)) admitNext();
  };

  const waitForAdmission = (session: LiveSession) =>
    new Promise<boolean>((resolvePromise) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        session.admissionWaiters.delete(finish);
        resolvePromise(ok);
      };
      const timer = setTimeout(() => finish(false), waitMs);
      session.admissionWaiters.add(finish);
    });

  const queuedResponse = () =>
    Response.json(
      {
        error: {
          code: "SESSION_QUEUED",
          message: "The session is waiting for a free transcoder.",
        },
      },
      {
        status: 503,
        headers: { ...standardHeaders, "retry-after": "1" },
      },
    );

  const liveSession = async (scope: SessionScope) => {
    // A request at the idle boundary waits for kill and rm to finish, then
    // gets a fresh session and directory.
    const cleanup = stopping.get(scope.sessionId);
    if (cleanup !== undefined) await cleanup.catch(() => {});
    const existing = sessions.get(scope.sessionId);
    if (existing !== undefined) return existing;
    const pending = loadSession(scope).then((session) => {
      requestSlot(session);
      return session;
    });
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
  ): Promise<Response> => {
    // A ready event may have landed during the transition that led here.
    if (session.state.ready.has(index)) {
      return Promise.resolve(serveSegmentFile(session, index));
    }
    return new Promise<Response>((resolvePromise) => {
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
  };

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

  const stopSession = (
    sessionId: string,
    reason: "idle" | "shutdown" | "ended",
  ) => {
    const work = (async () => {
      // The sessions entry goes first so new requests never touch the dying
      // object; the stopping entry lets them wait for cleanup instead.
      const pending = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (pending === undefined) return;
      const session = await pending.catch(() => null);
      if (session === null) return;
      if (session.idleTimer !== null) clearTimeout(session.idleTimer);
      session.stopped = true;
      await session.transition.catch(() => {});
      await session.current?.handle.kill();
      // ffmpeg is gone, so the slot is free for the next queued session.
      releaseSlot(session);
      for (const conversion of session.conversions.values()) {
        conversion.kill();
      }
      await Promise.allSettled(
        [...session.conversions.values()].map((conversion) => conversion.done),
      );
      rejectWaiters(session);
      for (const waiter of session.admissionWaiters) {
        waiter(false);
      }
      await Promise.allSettled(session.publishes);
      await session.registryWrites;
      await rm(session.directory, { recursive: true, force: true });
      log("info", "session.stopped", { sessionId, reason });
    })();
    stopping.set(sessionId, work);
    void work
      .finally(() => {
        if (stopping.get(sessionId) === work) stopping.delete(sessionId);
      })
      .catch(() => {});
    return work;
  };

  const stoppingResponse = () =>
    Response.json(
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

  const subtitleNotFound = () =>
    Response.json(
      { error: { code: "NOT_FOUND", message: "Subtitle track not found." } },
      { status: 404, headers: standardHeaders },
    );

  const offersSubtitle = (session: LiveSession, index: number) =>
    session.outputs.subtitles.some((subtitle) => subtitle.index === index);

  const serveSubtitle = async (session: LiveSession, index: number) => {
    const path = join(session.directory, `subs-${index}.vtt`);
    if (!session.conversions.has(index)) {
      await mkdir(session.directory, { recursive: true });
    }
    // A stop that ran during the mkdir has already removed the directory.
    if (session.stopped) return stoppingResponse();
    // Checked again after the await, so concurrent first requests share one
    // conversion instead of racing on the same file.
    let conversion = session.conversions.get(index);
    if (conversion === undefined) {
      const started = convertToWebvtt(session.inputPath, index, path);
      session.conversions.set(index, started);
      // A failed conversion is not cached; the next request tries again.
      started.done.catch(() => {
        if (session.conversions.get(index) === started) {
          session.conversions.delete(index);
        }
      });
      conversion = started;
    }
    try {
      await conversion.done;
    } catch (error) {
      log("error", "subtitle.failed", {
        sessionId: session.scope.sessionId,
        index,
        error: errorMessage(error),
      });
      throw error;
    }
    return new Response(Bun.file(path), {
      headers: { ...standardHeaders, "content-type": "text/vtt" },
    });
  };

  return {
    async serve(
      scope: SessionScope,
      name: HlsName,
      query: string,
    ): Promise<Response> {
      if (closed) return stoppingResponse();
      const session = await liveSession(scope);
      // A stop that began while the session loaded has already claimed it.
      if (closed || session.stopped) return stoppingResponse();
      touch(session);
      if (name.kind === "master" || name.kind === "media") {
        // Playlists come from the timeline, so a queued session answers them
        // too; its run starts with the first init or segment request.
        if (!session.queued) await ensureStarted(session);
        return playlist(
          name.kind === "master"
            ? buildMasterPlaylist(
                [session.outputs.variant],
                query,
                session.outputs.subtitles,
              )
            : buildMediaPlaylist(session.boundariesSeconds, query),
        );
      }
      if (name.kind === "subtitles" || name.kind === "subtitle") {
        if (!offersSubtitle(session, name.index)) return subtitleNotFound();
        if (name.kind === "subtitle") return serveSubtitle(session, name.index);
        return playlist(
          buildSubtitlePlaylist(
            name.index,
            session.boundariesSeconds.at(-1) ?? 0,
            query,
          ),
        );
      }
      if (session.queued && !(await waitForAdmission(session))) {
        return session.stopped ? stoppingResponse() : queuedResponse();
      }
      if (name.kind === "init") return serveInitRequest(session);
      return serveSegmentRequest(session, name.index);
    },
    /** Stops a session the client ended, freeing its slot at once instead of at the idle timeout. */
    async end(sessionId: string) {
      if (!sessions.has(sessionId)) return;
      await stopSession(sessionId, "ended");
    },
    async inspect(sessionId: string) {
      const session = await sessions.get(sessionId)?.catch(() => null);
      if (session === null || session === undefined) return undefined;
      return {
        runs: session.runs,
        running: session.current !== null,
        pid: session.current?.handle.pid ?? null,
        ready: [...session.state.ready].sort((a, b) => a - b),
        stripDolbyVision:
          session.outputs.video.action === "copy" &&
          session.outputs.video.stripDolbyVision,
        video: session.outputs.video.action,
        audio: session.outputs.audio?.action ?? "copy",
        burnSubtitle: session.outputs.burnSubtitle ?? null,
        queued: session.queued,
      };
    },
    async stop() {
      closed = true;
      // A stop already in flight adds to `stopping` mid-loop; keep draining
      // until both maps are empty.
      while (sessions.size > 0 || stopping.size > 0) {
        for (const sessionId of [...sessions.keys()]) {
          await stopSession(sessionId, "shutdown").catch((error: unknown) =>
            log("error", "session.stop_failed", {
              sessionId,
              error: errorMessage(error),
            }),
          );
        }
        await Promise.allSettled([...stopping.values()]);
      }
    },
  };
}
