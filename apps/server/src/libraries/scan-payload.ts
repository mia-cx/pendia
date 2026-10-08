import type { JobPayload, ScanChange } from "../db/schema/index.ts";
import type { createJobQueue, Dedupe } from "../jobs/queue.ts";
import { rootedKey } from "./roots.ts";

type Queue = ReturnType<typeof createJobQueue>;
type EnqueueOptions = Parameters<Queue["enqueue"]>[1];

type ScanPayload = Extract<JobPayload, { type: "scan" }>;

/** Retains provider assertions at their surviving destinations, in event arrival order. */
export function scanAssertions(changes: readonly ScanChange[]) {
  const assertions = new Map<string, Extract<ScanChange, { kind: "add" }>>();
  for (const change of changes) {
    const key = rootedKey(change);
    if (change.kind === "delete") {
      for (const [key, assertion] of assertions) {
        if (assertion.rootId !== change.rootId) continue;
        if (
          assertion.path === change.path ||
          (change.target === "item" &&
            (change.path === "." ||
              assertion.path.startsWith(`${change.path}/`)))
        )
          assertions.delete(key);
      }
      continue;
    }
    const previousKey =
      change.kind === "move"
        ? rootedKey({ rootId: change.rootId, path: change.previousPath })
        : key;
    const previous = assertions.get(previousKey);
    assertions.delete(previousKey);
    assertions.delete(key);
    assertions.set(key, {
      kind: "add",
      rootId: change.rootId,
      path: change.path,
      providerIds: { ...previous?.providerIds, ...change.providerIds },
    });
  }
  return [...assertions.values()];
}

/** A whole-Library scan fans out; children and explicit changes scan an Item folder, including `.`. */
export function isLibraryScan(
  payload: Pick<ScanPayload, "path" | "runId" | "changes">,
): boolean {
  return (
    payload.path === "." &&
    payload.runId === undefined &&
    payload.changes === undefined
  );
}

/**
 * The Dedupe that coalesces scan requests for one Library and scope, so a
 * whole-Library scan can still queue its own `.` folder child. Requests merge
 * their changes in arrival order into the queued follow-up; a running scan
 * covers only requests with no changes its reconcileMissing does not flag.
 */
export function scanDedupe(payload: ScanPayload): Dedupe {
  const scope = isLibraryScan(payload) ? "library" : "folder";
  return {
    key: `scan:${payload.libraryId}:${scope}:${payload.path}`,
    merge: (queued) => {
      if (queued.type !== "scan") return queued;
      const merged: ScanPayload = { ...queued };
      const changes = [...(queued.changes ?? []), ...(payload.changes ?? [])];
      if (changes.length > 0) merged.changes = changes;
      if (queued.reconcileMissing === true || payload.reconcileMissing === true)
        merged.reconcileMissing = true;
      return merged;
    },
    coveredBy: (running) =>
      running.type === "scan" &&
      (payload.changes?.length ?? 0) === 0 &&
      (payload.reconcileMissing !== true || running.reconcileMissing === true),
  };
}

/** Enqueues a scan, coalescing it into an unsettled scan of the same scope. */
export function enqueueScan(
  queue: Queue,
  scan: ScanPayload,
  options: EnqueueOptions = {},
) {
  return queue.enqueue(scan, { ...options, dedupe: scanDedupe(scan) });
}
