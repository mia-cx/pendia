import { dirname, isAbsolute, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { libraries, type ScanChange } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import { type ChangeEvent, radarrChanges, sonarrChanges } from "./servarr.ts";

const defaultDelayMs = 10_000;

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
    pending.delete(key);
    clearTimeout(batch.timer);
    const flushing = queue
      .enqueue(
        {
          type: "scan",
          libraryId: batch.libraryId,
          path: batch.path,
          changes: batch.changes,
        },
        { concurrencyKey: libraryConcurrencyKey(batch.libraryId) },
      )
      .then(() => undefined);
    inFlight.add(flushing);
    void flushing.then(
      () => inFlight.delete(flushing),
      () => inFlight.delete(flushing),
    );
    return flushing;
  };

  const schedule = (key: string, batch: PendingBatch) => {
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      void flushBatch(key).catch((error: unknown) => {
        recordFailure(error);
        try {
          onError(error);
        } catch {}
      });
    }, delayMs);
  };

  const submit = async (
    source: "sonarr" | "radarr",
    changes: ChangeEvent[],
  ): Promise<void> => {
    if (closePromise !== undefined)
      throw new InvalidWebhookError("Change debouncer is closed.");
    const medium = source === "sonarr" ? "shows" : "movies";
    const roots = await db
      .select({ id: libraries.id, rootPath: libraries.rootPath })
      .from(libraries)
      .where(eq(libraries.medium, medium));

    const locate = (path: string) => {
      let found:
        | { libraryId: string; relativePath: string; rootLength: number }
        | undefined;
      let ambiguous = false;
      for (const root of roots) {
        const normalized = resolve(root.rootPath);
        const relativePath = relative(normalized, resolve(path));
        if (
          relativePath === ".." ||
          relativePath.startsWith("../") ||
          isAbsolute(relativePath)
        )
          continue;
        if (found === undefined || normalized.length > found.rootLength) {
          found = {
            libraryId: root.id,
            relativePath,
            rootLength: normalized.length,
          };
          ambiguous = false;
        } else if (
          normalized.length === found.rootLength &&
          root.id !== found.libraryId
        ) {
          ambiguous = true;
        }
      }
      if (ambiguous)
        throw new InvalidWebhookError(
          "Webhook path matches duplicate library roots.",
        );
      return found;
    };

    const requireAbsolute = (path: string) => {
      if (path.includes("\0"))
        throw new InvalidWebhookError("Webhook path must not contain NUL.");
      if (!isAbsolute(path))
        throw new InvalidWebhookError("Webhook path must be absolute.");
    };

    const resolved: {
      key: string;
      libraryId: string;
      path: string;
      scan: ScanChange;
    }[] = [];
    for (const change of changes) {
      requireAbsolute(change.path);
      if (change.kind === "move") requireAbsolute(change.previousPath);
      const found = locate(change.path);
      if (found === undefined)
        throw new InvalidWebhookError(
          `No ${medium} library contains the webhook path.`,
        );

      let directory: string;
      let scan: ScanChange;
      if (change.kind === "delete" && change.target === "item") {
        const folder = found.relativePath === "" ? "." : found.relativePath;
        directory = folder;
        scan = {
          kind: "delete",
          path: folder,
          target: "item",
          providerIds: change.providerIds,
        };
      } else {
        if (found.relativePath === "")
          throw new InvalidWebhookError(
            "Webhook file path names a library root.",
          );
        if (change.kind === "move") {
          const previous = locate(change.previousPath);
          if (
            previous === undefined ||
            previous.libraryId !== found.libraryId ||
            previous.relativePath === ""
          )
            throw new InvalidWebhookError(
              "Webhook move crosses library roots.",
            );
          scan = {
            kind: "move",
            path: found.relativePath,
            previousPath: previous.relativePath,
            providerIds: change.providerIds,
          };
        } else if (change.kind === "add") {
          scan = {
            kind: "add",
            path: found.relativePath,
            providerIds: change.providerIds,
          };
        } else {
          scan = {
            kind: "delete",
            path: found.relativePath,
            target: "file",
            providerIds: change.providerIds,
          };
        }
        if (source === "sonarr") {
          const top = found.relativePath.split("/")[0];
          if (top === undefined || top === "")
            throw new InvalidWebhookError(
              "Webhook path must name a show folder.",
            );
          directory = top;
        } else {
          directory = dirname(found.relativePath);
        }
      }
      resolved.push({
        key: `${found.libraryId}:${directory}`,
        libraryId: found.libraryId,
        path: directory,
        scan,
      });
    }

    for (const entry of resolved) {
      let batch = pending.get(entry.key);
      if (batch === undefined) {
        batch = {
          libraryId: entry.libraryId,
          path: entry.path,
          changes: [],
          timer: undefined,
        };
        pending.set(entry.key, batch);
      }
      batch.changes.push(entry.scan);
      schedule(entry.key, batch);
    }
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      for (const batch of pending.values()) clearTimeout(batch.timer);
      for (const key of [...pending.keys()]) {
        try {
          await flushBatch(key);
        } catch (error) {
          recordFailure(error);
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

  return { submit, close };
}

/** Creates the Sonarr and Radarr webhook HTTP handler. */
export function createServarrWebhookHandler(
  db: Database,
  debouncer: ReturnType<typeof createChangeDebouncer>,
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
