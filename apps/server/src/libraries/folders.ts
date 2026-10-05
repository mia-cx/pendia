import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";

type Queryable = Pick<Database, "select">;

/** A folder browse failure that maps onto an API error code. */
export class FolderError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "FolderError";
  }
}

const hasCode = (error: unknown, ...codes: string[]): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  codes.includes(String(error.code));

const isUnreadable = (error: unknown) => hasCode(error, "EACCES", "EPERM");
const isMissing = (error: unknown) => hasCode(error, "ENOENT", "ENOTDIR");

const unreadable = () =>
  new FolderError(
    "BAD_REQUEST",
    "Pendia can't read this folder. Check its permissions.",
  );

/** lstat one component, translating the failures the browser names. */
async function statComponent(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isUnreadable(error)) throw unreadable();
    if (isMissing(error))
      throw new FolderError("NOT_FOUND", "This folder doesn't exist.");
    throw error;
  }
}

const naturalOrder = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Lists one absolute folder's direct child folders for an admin. Every path
 * component is lstat'ed on the way down, so no symlink is ever followed, and
 * dot-folders are hidden.
 */
export async function listFolders(
  db: Queryable,
  actorId: string,
  path: string,
): Promise<{ path: string; folders: { name: string; path: string }[] }> {
  await requirePermission(db, actorId, "manage-libraries");
  let folder = posix.normalize(path);
  if (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);

  const parts = folder.split("/").filter((part) => part !== "");
  let current = "/";
  let stat = await statComponent(current);
  for (const part of parts) {
    current = posix.join(current, part);
    stat = await statComponent(current);
    if (stat.isSymbolicLink())
      throw new FolderError(
        "BAD_REQUEST",
        "Pendia doesn't follow symbolic links.",
      );
  }
  if (!stat.isDirectory())
    throw new FolderError("BAD_REQUEST", "This isn't a folder.");

  const entries = await readdir(folder, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isUnreadable(error)) throw unreadable();
      throw error;
    },
  );
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(naturalOrder.compare);
  return {
    path: folder,
    folders: names.map((name) => ({ name, path: posix.join(folder, name) })),
  };
}
