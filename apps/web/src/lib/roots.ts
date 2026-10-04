import { ORPCError } from "@orpc/client";

/** One row in a library folders form: a saved root keeps its id, a new row has none. */
export type RootDraft = { id?: string; path: string };

/** The saved roots the draft leaves out, in the order they were saved. */
export function removedRoots(
  saved: readonly { id: string; path: string }[],
  draft: readonly RootDraft[],
): { id: string; path: string }[] {
  const kept = new Set(
    draft.flatMap((row) => (row.id === undefined ? [] : [row.id])),
  );
  return saved.filter((root) => !kept.has(root.id));
}

/** True when the save adds a folder or repoints one, which queues a full scan. */
export function queuesScan(
  saved: readonly { id: string; path: string }[],
  draft: readonly RootDraft[],
): boolean {
  const savedPaths = new Map(saved.map((root) => [root.id, root.path]));
  return draft.some(
    (row) =>
      row.id === undefined ||
      (savedPaths.has(row.id) && savedPaths.get(row.id) !== row.path),
  );
}

/** Reads a refused folder out of the server's BAD_REQUEST, if it names one row. */
export function refusedRoot(
  error: unknown,
): { index: number; message: string } | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) return undefined;
  const root = (data as Record<string, unknown>).root;
  if (typeof root !== "number") return undefined;
  return { index: root, message: error.message };
}
