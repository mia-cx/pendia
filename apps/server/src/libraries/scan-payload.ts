import type { JobPayload, ScanChange } from "../db/schema/index.ts";
import { rootedKey } from "./roots.ts";

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
  payload: Pick<
    Extract<JobPayload, { type: "scan" }>,
    "path" | "runId" | "changes"
  >,
): boolean {
  return (
    payload.path === "." &&
    payload.runId === undefined &&
    payload.changes === undefined
  );
}
