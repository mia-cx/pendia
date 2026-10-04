import { type FSWatcher, watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { WatchedChange } from "../libraries/webhooks.ts";

type Entry = { inode: string; bytes: bigint; modifiedNs: bigint };

/** Options for one watched tree. */
export type TreeOptions = {
  /** How long a path stays quiet before the tree reports it. */
  settleMs?: number;
  onError?: (error: unknown) => void;
};

const isEnoent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

async function readEntry(path: string): Promise<Entry | "directory" | null> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (stat.isDirectory()) return "directory";
    if (!stat.isFile()) return null;
    return {
      inode: `${stat.dev}:${stat.ino}`,
      bytes: stat.size,
      modifiedNs: stat.mtimeNs,
    };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Watches a directory tree with inotify and reports regular-file adds,
 * moves and deletes as root-relative paths. inotify gives no move cookies
 * here, so a path that appears with the inode of a vanished path is a move.
 */
export async function watchTree(
  root: string,
  onChanges: (changes: WatchedChange[]) => void,
  { settleMs = 200, onError = console.error }: TreeOptions = {},
) {
  const index = new Map<string, Entry>();
  const byInode = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let tail = Promise.resolve();
  let closed = false;

  const remember = (path: string, entry: Entry) => {
    const known = index.get(path);
    if (known !== undefined && byInode.get(known.inode) === path)
      byInode.delete(known.inode);
    index.set(path, entry);
    byInode.set(entry.inode, path);
  };
  const forget = (path: string) => {
    const known = index.get(path);
    if (known === undefined) return;
    index.delete(path);
    if (byInode.get(known.inode) === path) byInode.delete(known.inode);
  };

  /** Lists the regular files at or below a root-relative path. */
  async function list(path: string) {
    const found = new Map<string, Entry>();
    const entry = await readEntry(join(root, path));
    if (entry === null) return found;
    if (entry !== "directory") return found.set(path, entry);
    const glob = new Bun.Glob("**");
    for await (const child of glob.scan({
      cwd: join(root, path),
      dot: true,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const relative = path === "." ? child : `${path}/${child}`;
      const file = await readEntry(join(root, relative));
      if (file !== null && file !== "directory") found.set(relative, file);
    }
    return found;
  }

  /** Compares one settled path with the index and reports what changed. */
  async function reconcile(path: string) {
    const present = await list(path);
    const changes: WatchedChange[] = [];
    for (const [file, entry] of present) {
      const known = index.get(file);
      if (known?.inode === entry.inode) {
        if (
          known.bytes !== entry.bytes ||
          known.modifiedNs !== entry.modifiedNs
        )
          changes.push({ kind: "add", path: file });
        remember(file, entry);
        continue;
      }
      const previous = byInode.get(entry.inode);
      if (
        previous !== undefined &&
        (await readEntry(join(root, previous))) === null
      ) {
        forget(previous);
        changes.push({ kind: "move", path: file, previousPath: previous });
      } else {
        changes.push({ kind: "add", path: file });
      }
      remember(file, entry);
    }
    const missing = [...index.keys()].filter(
      (file) =>
        !present.has(file) && (file === path || file.startsWith(`${path}/`)),
    );
    // A vanished file waits one more settle so its new path can claim it as a move.
    if (missing.length > 0)
      setTimeout(() => enqueue(() => confirmGone(missing)), settleMs);
    if (changes.length > 0) onChanges(changes);
  }

  async function confirmGone(paths: readonly string[]) {
    const changes: WatchedChange[] = [];
    for (const path of paths) {
      if (!index.has(path) || (await readEntry(join(root, path))) !== null)
        continue;
      forget(path);
      changes.push({ kind: "delete", path });
    }
    if (changes.length > 0) onChanges(changes);
  }

  /** Runs index work one step at a time, so two settles never race. */
  const enqueue = (step: () => Promise<void>) => {
    if (closed) return;
    tail = tail.then(step).catch(onError);
  };

  const touch = (path: string) => {
    if (closed) return;
    clearTimeout(timers.get(path));
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        enqueue(() => reconcile(path));
      }, settleMs),
    );
  };

  const watcher: FSWatcher = watch(
    root,
    { recursive: true },
    (_event, filename) => {
      if (filename !== null) touch(filename);
    },
  );
  watcher.on("error", onError);
  // Events that arrive during the first walk settle after it.
  enqueue(async () => {
    for (const [path, entry] of await list(".")) remember(path, entry);
  });
  await tail;

  return {
    /** Stops watching and drops changes that have not settled. */
    close() {
      closed = true;
      watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
