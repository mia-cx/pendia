import { dirname, isAbsolute, relative, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  libraries,
  libraryRoots,
  type ScanChange,
} from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { leavesRoot } from "./changes.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import { scanScope } from "./scan.ts";
import { enqueueScan } from "./scan-payload.ts";
import { type ChangeEvent, radarrChanges, sonarrChanges } from "./servarr.ts";
import { acceptsLibraryFile } from "./walker.ts";

const defaultDelayMs = 10_000;

/** A root-relative file change a watcher saw on disk. */
export type WatchedChange =
  | { kind: "add" | "delete"; path: string }
  | { kind: "move"; path: string; previousPath: string };

type ResolvedChange = { libraryId: string; path: string; scan: ScanChange };

class InvalidWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebhookError";
  }
}

/** Options for directory change coalescing. */
export type ChangeDebouncerOptions = {
  delayMs?: number;
  onError?: (error: unknown) => void;
};

type PendingBatch = {
  libraryId: string;
  path: string;
  changes: ScanChange[];
  timer: ReturnType<typeof setTimeout> | undefined;
  flushing: Promise<void> | undefined;
};

const webhookPattern = /^\/api\/webhooks\/(sonarr|radarr)\/([^/]+)$/;

function respond(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  const merged = new Headers(headers);
  if (!merged.has("Cache-Control")) merged.set("Cache-Control", "no-store");
  if (!merged.has("X-Content-Type-Options"))
    merged.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers: merged });
}

const invalidPayload = () =>
  respond(
    {
      error: { code: "INVALID_INPUT", message: "Invalid webhook payload." },
    },
    400,
  );

/** Coalesces absolute writer changes into directory scan jobs. */
export function createChangeDebouncer(
  db: Database,
  options: ChangeDebouncerOptions = {},
) {
  const delayMs = options.delayMs ?? defaultDelayMs;
  if (!Number.isFinite(delayMs) || delayMs < 0)
    throw new InvalidWebhookError(
      "Change delay must be finite and non-negative.",
    );
  const onError = options.onError ?? (() => {});
  const queue = createJobQueue(db);
  const pending = new Map<string, PendingBatch>();
  const inFlight = new Set<Promise<void>>();
  const submissions = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let flushFailed = false;
  let flushFailure: unknown;

  const recordFailure = (error: unknown) => {
    if (!flushFailed) {
      flushFailed = true;
      flushFailure = error;
    }
  };

  const flushBatch = (key: string): Promise<void> => {
    const batch = pending.get(key);
    if (batch === undefined) return Promise.resolve();
    if (batch.flushing !== undefined) return batch.flushing;
    clearTimeout(batch.timer);
    batch.timer = undefined;
    const persisted = batch.changes.slice();
    const flushing = enqueueScan(
      queue,
      {
        type: "scan",
        libraryId: batch.libraryId,
        path: batch.path,
        changes: persisted,
      },
      { concurrencyKey: libraryConcurrencyKey(batch.libraryId) },
    ).then(() => undefined);
    batch.flushing = flushing;
    inFlight.add(flushing);
    void flushing.then(
      () => {
        inFlight.delete(flushing);
        batch.flushing = undefined;
        batch.changes.splice(0, persisted.length);
        if (batch.changes.length === 0) {
          if (pending.get(key) === batch) pending.delete(key);
        } else {
          schedule(key, batch);
        }
      },
      () => {
        inFlight.delete(flushing);
        batch.flushing = undefined;
      },
    );
    return flushing;
  };

  const schedule = (key: string, batch: PendingBatch) => {
    if (closed) return;
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      void flushBatch(key).catch((error: unknown) => {
        try {
          onError(error);
        } catch {}
        if (!closed && pending.get(key) === batch) schedule(key, batch);
      });
    }, delayMs);
  };

  const submitChanges = async (
    source: "sonarr" | "radarr",
    changes: ChangeEvent[],
  ): Promise<void> => {
    const medium = source === "sonarr" ? "shows" : "movies";
    const { rules } = scanScope(medium);
    const roots = await db
      .select({
        id: libraryRoots.id,
        libraryId: libraryRoots.libraryId,
        path: libraryRoots.path,
      })
      .from(libraryRoots)
      .innerJoin(libraries, eq(libraries.id, libraryRoots.libraryId))
      .where(eq(libraries.medium, medium));

    // The longest root containing the path. Roots never overlap, so at most one does.
    const locate = (path: string) => {
      let found:
        | {
            libraryId: string;
            rootId: string;
            relativePath: string;
            rootLength: number;
          }
        | undefined;
      for (const root of roots) {
        const relativePath = relative(root.path, resolve(path));
        if (
          relativePath === ".." ||
          relativePath.startsWith("../") ||
          isAbsolute(relativePath)
        )
          continue;
        if (found === undefined || root.path.length > found.rootLength)
          found = {
            libraryId: root.libraryId,
            rootId: root.id,
            relativePath,
            rootLength: root.path.length,
          };
      }
      return found;
    };

    const requireAbsolute = (path: string) => {
      if (path.includes("\0"))
        throw new InvalidWebhookError("Webhook path must not contain NUL.");
      if (!isAbsolute(path))
        throw new InvalidWebhookError("Webhook path must be absolute.");
    };

    // The folder one scan covers: the file's Item folder, "." at the root.
    const scanFolder = (relativePath: string) =>
      rules.itemFolder(dirname(relativePath));

    const resolved: ResolvedChange[] = [];
    for (const change of changes) {
      requireAbsolute(change.path);
      if (change.kind === "move") requireAbsolute(change.previousPath);
      const found = locate(change.path);
      if (found === undefined)
        throw new InvalidWebhookError(
          `No ${medium} library contains the webhook path.`,
        );

      const { libraryId, rootId } = found;
      let directory: string;
      let previousDirectory: string | undefined;
      let scan: ScanChange;
      if (change.kind === "delete" && change.target === "item") {
        const folder = found.relativePath === "" ? "." : found.relativePath;
        directory = folder;
        scan = {
          kind: "delete",
          rootId,
          path: folder,
          target: "item",
          providerIds: change.providerIds,
        };
      } else {
        directory = scanFolder(found.relativePath);
        if (change.kind === "move") {
          const previous = locate(change.previousPath);
          if (previous === undefined || previous.libraryId !== libraryId)
            throw new InvalidWebhookError(
              "Webhook move crosses library roots.",
            );
          previousDirectory = scanFolder(previous.relativePath);
          // A move between two roots of one Library leaves its source
          // root, and the destination folder's scan adds it there.
          if (previous.rootId !== rootId) {
            resolved.push(
              {
                libraryId,
                path: previousDirectory,
                scan: {
                  kind: "delete",
                  rootId: previous.rootId,
                  path: previous.relativePath,
                  target: "file",
                  providerIds: {},
                },
              },
              {
                libraryId,
                path: directory,
                scan: {
                  kind: "add",
                  rootId,
                  path: found.relativePath,
                  providerIds: change.providerIds,
                },
              },
            );
            continue;
          }
          scan = {
            kind: "move",
            rootId,
            path: found.relativePath,
            previousPath: previous.relativePath,
            providerIds: change.providerIds,
          };
        } else if (change.kind === "add") {
          scan = {
            kind: "add",
            rootId,
            path: found.relativePath,
            providerIds: change.providerIds,
          };
        } else {
          scan = {
            kind: "delete",
            rootId,
            path: found.relativePath,
            target: "file",
            providerIds: change.providerIds,
          };
        }
      }
      resolved.push({ libraryId, path: directory, scan });
      // A move into another Show or Movie scans its source too. Servarr's
      // provider ids name the destination, so the source scan goes without them.
      if (
        scan.kind === "move" &&
        previousDirectory !== undefined &&
        previousDirectory !== directory
      ) {
        const [file] = await db
          .select({ itemId: files.itemId })
          .from(files)
          .where(
            and(eq(files.rootId, rootId), eq(files.path, scan.previousPath)),
          );
        if (
          file !== undefined &&
          (await leavesRoot(db, libraryId, file.itemId, scan.path))
        )
          resolved.push({
            libraryId,
            path: previousDirectory,
            scan: { ...scan, providerIds: {} },
          });
      }
    }
    queueChanges(resolved);
  };

  /** Turns a watcher's root-relative file changes in one root into scan changes of the medium's files. */
  const submitWatchedChanges = async (
    rootId: string,
    changes: readonly WatchedChange[],
  ): Promise<number> => {
    const [library] = await db
      .select({ id: libraries.id, medium: libraries.medium })
      .from(libraryRoots)
      .innerJoin(libraries, eq(libraries.id, libraryRoots.libraryId))
      .where(eq(libraryRoots.id, rootId));
    if (library === undefined) throw new AuthError("NOT_FOUND");
    const libraryId = library.id;
    const { rules } = scanScope(library.medium);
    const accepts = (path: string) => acceptsLibraryFile(rules, path);
    const resolved: ResolvedChange[] = [];
    for (const change of changes) {
      // A rename into or out of the medium's files is an add or a delete.
      const scan: ScanChange | undefined =
        change.kind === "move" && accepts(change.previousPath)
          ? accepts(change.path)
            ? { ...change, rootId, providerIds: {} }
            : {
                kind: "delete",
                rootId,
                path: change.previousPath,
                target: "file",
                providerIds: {},
              }
          : !accepts(change.path)
            ? undefined
            : change.kind === "delete"
              ? { ...change, rootId, target: "file", providerIds: {} }
              : { kind: "add", rootId, path: change.path, providerIds: {} };
      if (scan === undefined) continue;
      resolved.push({
        libraryId,
        path: rules.itemFolder(dirname(scan.path)),
        scan,
      });
    }
    queueChanges(resolved);
    return resolved.length;
  };

  const queueChanges = (resolved: readonly ResolvedChange[]) => {
    for (const { libraryId, path, scan } of resolved) {
      const key = `${libraryId}:${path}`;
      let batch = pending.get(key);
      if (batch === undefined) {
        batch = {
          libraryId,
          path,
          changes: [],
          timer: undefined,
          flushing: undefined,
        };
        pending.set(key, batch);
      }
      batch.changes.push(scan);
      schedule(key, batch);
    }
  };

  let submissionTail: Promise<void> = Promise.resolve();

  /** Runs submissions one at a time, in arrival order. */
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new InvalidWebhookError("Change debouncer is closed."),
      );
    }
    const submission = submissionTail.then(run);
    submissionTail = submission.then(
      () => undefined,
      () => undefined,
    );
    submissions.add(submission);
    void submission.then(
      () => submissions.delete(submission),
      () => submissions.delete(submission),
    );
    return submission;
  };

  const submit = (source: "sonarr" | "radarr", changes: ChangeEvent[]) =>
    serialize(() => submitChanges(source, changes));

  /** Queues a watcher's changes in one root and returns how many were media files. */
  const submitWatched = (rootId: string, changes: readonly WatchedChange[]) =>
    serialize(() => submitWatchedChanges(rootId, changes));

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      for (const batch of pending.values()) clearTimeout(batch.timer);
      while (submissions.size > 0) {
        await Promise.allSettled([...submissions]);
      }
      for (const key of [...pending.keys()]) {
        while (pending.has(key)) {
          try {
            await flushBatch(key);
          } catch (error) {
            recordFailure(error);
            break;
          }
        }
      }
      while (inFlight.size > 0) {
        for (const result of await Promise.allSettled([...inFlight])) {
          if (result.status === "rejected") recordFailure(result.reason);
        }
      }
      if (flushFailed) throw flushFailure;
    })();
    return closePromise;
  };

  return { submit, submitWatched, close };
}

/** Creates the Sonarr and Radarr webhook HTTP handler. */
export function createServarrWebhookHandler(
  db: Database,
  debouncer: Pick<ReturnType<typeof createChangeDebouncer>, "submit">,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = new URL(request.url).pathname.match(webhookPattern);
    if (match === null) return undefined;
    const source = match[1];
    const secret = match[2];
    if (source === undefined || secret === undefined) return undefined;
    if (source !== "sonarr" && source !== "radarr") return undefined;
    if (request.method !== "POST")
      return respond(
        {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "Method not allowed.",
          },
        },
        405,
        { Allow: "POST" },
      );
    try {
      const auth = await authenticate(db, secret);
      if (auth.credential.kind !== "api-key")
        throw new AuthError("UNAUTHENTICATED");
      await requirePermission(db, auth.user.id, "manage-libraries");
    } catch (error) {
      if (error instanceof AuthError)
        return respond(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      throw error;
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidPayload();
    }
    let changes: ChangeEvent[];
    try {
      changes = source === "sonarr" ? sonarrChanges(body) : radarrChanges(body);
    } catch {
      return invalidPayload();
    }
    try {
      await debouncer.submit(source, changes);
    } catch (error) {
      if (error instanceof InvalidWebhookError) return invalidPayload();
      throw error;
    }
    return respond({ accepted: changes.length }, 202);
  };
}
