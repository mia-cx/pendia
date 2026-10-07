import type { JobPayload } from "../db/schema/index.ts";

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
