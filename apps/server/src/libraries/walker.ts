import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import type { ScanRules } from "../mediums/medium.ts";

/** A regular file inside a library with exact byte size and nanosecond mtime. */
export interface LibraryFile {
  path: string;
  bytes: bigint;
  modifiedNs: bigint;
  modifiedAt: Date;
}

/** Signals that the requested library subtree does not exist. */
export class MissingLibraryPathError extends Error {}

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const normalizeRelative = (path: string): string => {
  if (path.includes("\0")) {
    throw new Error("Library path contains NUL.");
  }
  if (posix.isAbsolute(path)) {
    throw new Error("Library path must be relative.");
  }
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new Error("Library path escapes the root.");
  }
  return parts.join("/") || ".";
};

async function resolveEntry(
  rootPath: string,
  path: string,
): Promise<{ absolute: string; relative: string; stat: BigIntStats }> {
  if (!isAbsolute(rootPath)) {
    throw new Error("Library root must be an absolute path.");
  }
  const rootStat = await lstat(rootPath, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new Error("Library root is not a directory.");
  }
  const relative = normalizeRelative(path);
  let absolute = rootPath;
  let stat = rootStat;
  const parts = relative === "." ? [] : relative.split("/");
  for (const [index, part] of parts.entries()) {
    absolute = resolve(absolute, part);
    stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error(`Library path crosses a symlink: ${relative}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Library path crosses a non-directory: ${relative}`);
    }
  }
  return { absolute, relative, stat };
}

const toLibraryFile = (relative: string, stat: BigIntStats): LibraryFile => ({
  path: relative,
  bytes: stat.size,
  modifiedNs: stat.mtimeNs,
  modifiedAt: new Date(Number(stat.mtimeNs / 1000000n)),
});

/** Stat a library-relative regular file without following any symlinks. */
export async function readLibraryFile(
  rootPath: string,
  path: string,
): Promise<LibraryFile> {
  const { relative, stat } = await resolveEntry(rootPath, path);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${relative}`);
  }
  return toLibraryFile(relative, stat);
}

/** Walk a library subtree, yielding the files the medium's scan rules accept. */
export async function* walkLibrary(
  rootPath: string,
  rules: ScanRules,
  options: { path?: string; recursive?: boolean } = {},
): AsyncGenerator<LibraryFile> {
  const recursive = options.recursive ?? true;
  const prunesDirectory = (relative: string) =>
    relative
      .split("/")
      .some((part) => part.toLowerCase().endsWith(".pendia")) ||
    (rules.isExtra(`${relative}/placeholder.mkv`) &&
      !rules.identify(`${relative}/${posix.basename(relative)}.mkv`));
  let start: Awaited<ReturnType<typeof resolveEntry>>;
  try {
    start = await resolveEntry(rootPath, options.path ?? ".");
  } catch (error) {
    if (isEnoent(error)) {
      throw new MissingLibraryPathError(
        `Library subtree does not exist: ${options.path ?? "."}`,
      );
    }
    throw error;
  }
  if (start.stat.isFile()) {
    if (rules.identify(start.relative) && !rules.isExtra(start.relative)) {
      yield toLibraryFile(start.relative, start.stat);
    }
    return;
  }
  if (!start.stat.isDirectory()) {
    return;
  }
  if (prunesDirectory(start.relative)) {
    return;
  }
  const visit = async function* (
    absolute: string,
    relative: string,
  ): AsyncGenerator<LibraryFile> {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (recursive && !prunesDirectory(child)) {
          const validated = await resolveEntry(rootPath, child);
          if (validated.stat.isDirectory()) {
            yield* visit(validated.absolute, validated.relative);
          }
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!rules.identify(child) || rules.isExtra(child)) {
        continue;
      }
      yield await readLibraryFile(rootPath, child);
    }
  };
  yield* visit(start.absolute, start.relative);
}
