import type { BigIntStats, Dirent } from "node:fs";
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
export class MissingLibraryPathError extends Error {
  constructor(
    readonly path: string,
    readonly scope: "root" | "requested" | "entry",
  ) {
    super(`Library path does not exist: ${path}`);
    this.name = "MissingLibraryPathError";
  }
}

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const revalidateRoot = async (
  rootPath: string,
  rootStat: BigIntStats,
): Promise<void> => {
  let currentRoot: BigIntStats;
  try {
    currentRoot = await lstat(rootPath, { bigint: true });
  } catch (error) {
    if (isEnoent(error)) throw new MissingLibraryPathError(".", "root");
    throw error;
  }
  if (
    !currentRoot.isDirectory() ||
    currentRoot.dev !== rootStat.dev ||
    currentRoot.ino !== rootStat.ino
  ) {
    throw new MissingLibraryPathError(".", "root");
  }
};

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
  scope: "requested" | "entry",
): Promise<{ absolute: string; relative: string; stat: BigIntStats }> {
  if (!isAbsolute(rootPath)) {
    throw new Error("Library root must be an absolute path.");
  }
  let rootStat: BigIntStats;
  try {
    rootStat = await lstat(rootPath, { bigint: true });
  } catch (error) {
    if (isEnoent(error)) throw new MissingLibraryPathError(".", "root");
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new Error("Library root is not a directory.");
  }
  const relative = normalizeRelative(path);
  let absolute = rootPath;
  let stat = rootStat;
  const parts = relative === "." ? [] : relative.split("/");
  for (const [index, part] of parts.entries()) {
    absolute = resolve(absolute, part);
    try {
      stat = await lstat(absolute, { bigint: true });
    } catch (error) {
      if (isEnoent(error)) {
        await revalidateRoot(rootPath, rootStat);
        throw new MissingLibraryPathError(
          parts.slice(0, index + 1).join("/"),
          scope,
        );
      }
      throw error;
    }
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
  const { relative, stat } = await resolveEntry(rootPath, path, "entry");
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${relative}`);
  }
  return toLibraryFile(relative, stat);
}

const prunesDirectory = (rules: ScanRules, relative: string): boolean =>
  relative.split("/").some((part) => part.toLowerCase().endsWith(".pendia")) ||
  (rules.isExtra(`${relative}/placeholder.mkv`) &&
    !rules.identify(`${relative}/${posix.basename(relative)}.mkv`));

/** Walk a library subtree, yielding the files the medium's scan rules accept. */
export async function* walkLibrary(
  rootPath: string,
  rules: ScanRules,
  options: { path?: string; recursive?: boolean } = {},
): AsyncGenerator<LibraryFile> {
  const recursive = options.recursive ?? true;
  const start = await resolveEntry(rootPath, options.path ?? ".", "requested");
  if (start.stat.isFile()) {
    if (rules.identify(start.relative) && !rules.isExtra(start.relative)) {
      yield toLibraryFile(start.relative, start.stat);
    }
    return;
  }
  if (!start.stat.isDirectory()) {
    return;
  }
  if (prunesDirectory(rules, start.relative)) {
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
        if (recursive && !prunesDirectory(rules, child)) {
          const validated = await resolveEntry(rootPath, child, "entry");
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

/** A library directory with its exact mtime and accepted direct files. */
export interface LibraryDirectory {
  path: string;
  modifiedNs: bigint;
  files: string[];
}

/** Walks directory mtimes without statting every file. */
export async function* walkLibraryDirectories(
  rootPath: string,
  rules: ScanRules,
): AsyncGenerator<LibraryDirectory> {
  const start = await resolveEntry(rootPath, ".", "requested");
  if (!start.stat.isDirectory() || prunesDirectory(rules, start.relative)) {
    return;
  }
  const visit = async function* (
    absolute: string,
    relative: string,
    stat: BigIntStats,
  ): AsyncGenerator<LibraryDirectory> {
    let entries: Dirent[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) {
        await revalidateRoot(rootPath, start.stat);
        if (relative !== ".") return;
        throw new MissingLibraryPathError(".", "root");
      }
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files: string[] = [];
    const directories: string[] = [];
    for (const entry of entries) {
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!prunesDirectory(rules, child)) {
          directories.push(child);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (rules.identify(child) && !rules.isExtra(child)) {
        files.push(child);
      }
    }
    yield { path: relative, modifiedNs: stat.mtimeNs, files };
    for (const child of directories) {
      let validated: Awaited<ReturnType<typeof resolveEntry>>;
      try {
        validated = await resolveEntry(rootPath, child, "entry");
      } catch (error) {
        if (
          error instanceof MissingLibraryPathError &&
          error.scope === "entry"
        ) {
          continue;
        }
        throw error;
      }
      if (validated.stat.isDirectory()) {
        yield* visit(validated.absolute, validated.relative, validated.stat);
      }
    }
  };
  yield* visit(start.absolute, start.relative, start.stat);
}
