import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { artwork } from "../db/schema/index.ts";

/** Where this process stores new artwork originals, chosen once at setup. */
export type ArtworkStoreConfig =
  // path is the fallback for a read-only media share.
  | { backend: "colocated"; path?: string }
  | { backend: "configured-path"; path: string }
  | { backend: "s3"; client: Bun.S3Client };

/** The backend an artwork row records. */
export type ArtworkBackendName = (typeof artwork.$inferSelect)["backend"];

/** Reads the artwork store choice from environment variables. */
export function readArtworkStoreConfig(
  env: Record<string, string | undefined>,
): ArtworkStoreConfig {
  const path = env.PENDIA_ARTWORK_PATH?.trim() || undefined;
  if (path !== undefined && !isAbsolute(path))
    throw new Error("PENDIA_ARTWORK_PATH must be an absolute path.");
  const store = env.PENDIA_ARTWORK_STORE?.trim() || "colocated";
  if (store === "colocated")
    return path === undefined
      ? { backend: "colocated" }
      : { backend: "colocated", path };
  if (store === "path") {
    if (path === undefined)
      throw new Error("PENDIA_ARTWORK_STORE=path needs PENDIA_ARTWORK_PATH.");
    return { backend: "configured-path", path };
  }
  if (store === "s3") {
    // The same names Bun's S3 client reads, S3_ first, then AWS_.
    const s3 = (name: string) =>
      env[`S3_${name}`]?.trim() || env[`AWS_${name}`]?.trim() || undefined;
    const bucket = s3("BUCKET");
    if (bucket === undefined)
      throw new Error("PENDIA_ARTWORK_STORE=s3 needs S3_BUCKET.");
    const accessKeyId = s3("ACCESS_KEY_ID");
    const secretAccessKey = s3("SECRET_ACCESS_KEY");
    if (accessKeyId === undefined || secretAccessKey === undefined)
      throw new Error(
        "PENDIA_ARTWORK_STORE=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).",
      );
    return {
      backend: "s3",
      client: new Bun.S3Client({
        bucket,
        endpoint: s3("ENDPOINT"),
        region: s3("REGION"),
        accessKeyId,
        secretAccessKey,
      }),
    };
  }
  throw new Error(
    `PENDIA_ARTWORK_STORE must be colocated, path or s3. Found "${store}".`,
  );
}

let fromEnvironment: ArtworkStoreConfig | undefined;

/** The process artwork store, read from the environment on first use. */
export function artworkStoreConfig(): ArtworkStoreConfig {
  fromEnvironment ??= readArtworkStoreConfig(Bun.env);
  return fromEnvironment;
}

/** One place artwork originals live, addressed by storage key. */
export interface ArtworkBackend {
  /** Writes an original under a key that is not yet in use. */
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** Reads an original, or null when it is gone. */
  read(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  /** Removes an original; a missing one is not an error. */
  remove(key: string): Promise<void>;
}

/** Opens an artwork original without following a final symlink. */
export type ArtworkOpen = (path: string, flags: number) => Promise<FileHandle>;

/** Resolves the backend holding a row's original, or null when this process has none of that kind. */
export function artworkBackend(
  store: ArtworkStoreConfig,
  name: ArtworkBackendName,
  libraryRoot: string,
  openFile: ArtworkOpen = open,
): ArtworkBackend | null {
  if (name === "colocated") return directoryBackend(libraryRoot, openFile);
  if (name === "configured-path")
    return store.backend !== "s3" && store.path !== undefined
      ? directoryBackend(store.path, openFile, true)
      : null;
  return store.backend === "s3" ? s3Backend(store.client) : null;
}

/** Where a new original landed: the backend its row records and its key there. */
export interface WrittenOriginal {
  backend: ArtworkBackendName;
  storageKey: string;
}

/** Writes a new original to the process store; a read-only colocated share falls back to the configured path. */
export async function writeArtworkOriginal(
  store: ArtworkStoreConfig,
  libraryRoot: string,
  itemFolder: string,
  name: string,
  bytes: Uint8Array,
): Promise<WrittenOriginal> {
  if (store.backend === "s3") {
    await s3Backend(store.client).write(name, bytes);
    return { backend: "s3", storageKey: name };
  }
  if (store.backend === "configured-path") {
    await directoryBackend(store.path, open, true).write(name, bytes);
    return { backend: "configured-path", storageKey: name };
  }
  const storageKey = `${itemFolder}/.pendia/artwork/${name}`;
  const { root } = resolveStoragePath(libraryRoot, storageKey);
  // The Item folder must exist already; only .pendia/artwork is created.
  await walkStorageDirectory(root, join(root, itemFolder), false);
  try {
    await directoryBackend(root).write(storageKey, bytes);
    return { backend: "colocated", storageKey };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (store.path === undefined || (code !== "EROFS" && code !== "EACCES"))
      throw error;
  }
  await directoryBackend(store.path, open, true).write(name, bytes);
  return { backend: "configured-path", storageKey: name };
}

/** Resolves a storage key under a root, rejecting any key that could escape it. */
function resolveStoragePath(
  rootPath: string,
  storageKey: string,
): { root: string; target: string } {
  const segments = storageKey.split("/");
  if (
    posix.isAbsolute(storageKey) ||
    storageKey.includes("\0") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new Error("Invalid artwork storage path.");
  const root = resolve(rootPath);
  const target = resolve(root, ...segments);
  const rel = relative(root, target);
  if (rel === "" || isAbsolute(rel) || rel.split(sep).includes(".."))
    throw new Error("Invalid artwork storage path.");
  return { root, target };
}

/** Signals that a storage parent component is absent on disk. */
class MissingArtworkStoragePathError extends Error {}

async function statOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Walks from root to directory without following symlinks, creating missing parts on request. */
async function walkStorageDirectory(
  root: string,
  directory: string,
  create: boolean,
) {
  const rel = relative(root, directory);
  if (isAbsolute(rel) || rel.split(sep).includes(".."))
    throw new Error("Invalid artwork storage path.");
  const rootStat = await statOrNull(root);
  if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("Invalid artwork storage path.");
  let current = root;
  for (const part of rel === "" ? [] : rel.split(sep)) {
    current = join(current, part);
    let stat = await statOrNull(current);
    if (stat === null) {
      if (!create) throw new MissingArtworkStoragePathError();
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = await statOrNull(current);
      if (stat === null) throw new Error("Invalid artwork storage path.");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Invalid artwork storage path.");
  }
}

/** True when the walk stopped at a missing directory rather than an invalid one. */
async function walkExisting(root: string, directory: string) {
  try {
    await walkStorageDirectory(root, directory, false);
    return true;
  } catch (error) {
    if (error instanceof MissingArtworkStoragePathError) return false;
    throw error;
  }
}

/** Opens a regular file under the root, or returns null when it is gone. */
async function openOriginal(
  openFile: ArtworkOpen,
  target: string,
  flags: number,
): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await openFile(target, flags | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error("Invalid artwork storage path.");
    throw error;
  }
  if ((await handle.stat()).isFile()) return handle;
  await handle.close();
  throw new Error("Invalid artwork storage path.");
}

/** A directory tree of originals that never follows a symlink out of its root. */
function directoryBackend(
  rootPath: string,
  openFile: ArtworkOpen = open,
  createRoot = false,
): ArtworkBackend {
  return {
    async write(key, bytes) {
      const { root, target } = resolveStoragePath(rootPath, key);
      await walkStorageDirectory(
        createRoot ? parse(root).root : root,
        dirname(target),
        true,
      );
      const temporary = `${target}.${Bun.randomUUIDv7()}.tmp`;
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async read(key) {
      const { root, target } = resolveStoragePath(rootPath, key);
      if (!(await walkExisting(root, dirname(target)))) return null;
      const handle = await openOriginal(openFile, target, constants.O_RDONLY);
      if (handle === null) return null;
      try {
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
    async exists(key) {
      const { root, target } = resolveStoragePath(rootPath, key);
      if (!(await walkExisting(root, dirname(target)))) return false;
      // O_NONBLOCK keeps a planted FIFO from hanging the check.
      const handle = await openOriginal(
        openFile,
        target,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      await handle?.close();
      return handle !== null;
    },
    async remove(key) {
      const { root, target } = resolveStoragePath(rootPath, key);
      if (!(await walkExisting(root, dirname(target)))) return;
      await rm(target, { force: true });
    },
  };
}

/** An S3-compatible bucket of originals; a single PUT makes each one visible whole. */
function s3Backend(client: Bun.S3Client): ArtworkBackend {
  return {
    async write(key, bytes) {
      await client.write(key, bytes);
    },
    async read(key) {
      try {
        return await client.file(key).bytes();
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "NoSuchKey"
        )
          return null;
        throw error;
      }
    },
    exists: (key) => client.exists(key),
    async remove(key) {
      await client.delete(key);
    },
  };
}
