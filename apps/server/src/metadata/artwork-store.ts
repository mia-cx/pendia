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
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { MetadataResult } from "@pendia/plugin-api";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { artwork, items, libraries } from "../db/schema/index.ts";

type ArtworkCandidate = MetadataResult["artwork"][number];

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

async function statOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function walkStorageDirectory(
  root: string,
  directory: string,
  create: boolean,
) {
  const rel = relative(root, directory);
  if (rel === "" || isAbsolute(rel) || rel.split(sep).includes(".."))
    throw new Error("Invalid artwork storage path.");
  const rootStat = await statOrNull(root);
  if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("Invalid artwork storage path.");
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let stat = await statOrNull(current);
    if (stat === null) {
      if (!create) throw new Error("Invalid artwork storage path.");
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

async function readBoundedBody(
  response: Response,
  maxDownloadBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(declared) && Number(declared) > maxDownloadBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Artwork response too large.");
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxDownloadBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Artwork response too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Stores one selected artwork original in the Item's colocated backend. */
export async function storeArtworkOriginal(
  db: Database,
  itemId: string,
  candidate: ArtworkCandidate,
  request: typeof fetch = fetch,
  timeoutMs = 30_000,
  maxDownloadBytes = 32 * 1024 * 1024,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid artwork request timeout.");
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < 1)
    throw new Error("Invalid artwork download limit.");
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new AuthError("NOT_FOUND");
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, item.libraryId));
  if (!library) throw new AuthError("NOT_FOUND");

  const response = await request(candidate.url, {
    headers: { accept: "image/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`Artwork request failed with status ${response.status}.`);
  const bytes = await readBoundedBody(response, maxDownloadBytes);
  let dimensions: { width: number; height: number };
  try {
    const image = sharp(bytes);
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (
      !Number.isInteger(width) ||
      width < 1 ||
      !Number.isInteger(height) ||
      height < 1
    )
      throw new Error("Invalid artwork response.");
    await image.stats();
    dimensions = { width, height };
  } catch {
    throw new Error("Invalid artwork response.");
  }

  let freshTarget: string | undefined;
  let freshKey: string | undefined;
  const stored = await db
    .transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");
      if (!locked) throw new AuthError("NOT_FOUND");
      const [lockedLibrary] = await tx
        .select()
        .from(libraries)
        .where(eq(libraries.id, locked.libraryId));
      if (!lockedLibrary) throw new AuthError("NOT_FOUND");

      const [selected] = await tx
        .select()
        .from(artwork)
        .where(
          and(
            eq(artwork.itemId, itemId),
            eq(artwork.type, candidate.type),
            eq(artwork.selected, true),
          ),
        );
      const reused = selected?.backend === "colocated" ? selected : undefined;
      const artworkId = reused?.id ?? Bun.randomUUIDv7();
      const previousTarget =
        reused === undefined
          ? undefined
          : resolveStoragePath(lockedLibrary.rootPath, reused.storageKey)
              .target;
      const storageKey = `${locked.canonicalFolder}/.pendia/artwork/${artworkId}.${Bun.randomUUIDv7()}`;
      const { root, target } = resolveStoragePath(
        lockedLibrary.rootPath,
        storageKey,
      );
      await walkStorageDirectory(root, dirname(target), true);
      const temporary = `${target}.${Bun.randomUUIDv7()}.tmp`;
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      freshTarget = target;
      freshKey = storageKey;

      await tx
        .update(artwork)
        .set({ selected: false })
        .where(
          and(
            eq(artwork.itemId, itemId),
            eq(artwork.type, candidate.type),
            eq(artwork.selected, true),
          ),
        );
      if (reused) {
        const [row] = await tx
          .update(artwork)
          .set({
            sourceUrl: candidate.url,
            backend: "colocated",
            storageKey,
            width: dimensions.width,
            height: dimensions.height,
            selected: true,
          })
          .where(eq(artwork.id, reused.id))
          .returning();
        if (!row) throw new Error("Artwork update returned no row.");
        return { row, previousTarget, target };
      }
      const [row] = await tx
        .insert(artwork)
        .values({
          id: artworkId,
          itemId,
          versionId: null,
          type: candidate.type,
          sourceUrl: candidate.url,
          backend: "colocated",
          storageKey,
          width: dimensions.width,
          height: dimensions.height,
          selected: true,
        })
        .returning();
      if (!row) throw new Error("Artwork insertion returned no row.");
      return { row, previousTarget, target };
    })
    .catch(async (error: unknown) => {
      if (freshTarget !== undefined && freshKey !== undefined) {
        const referenced = await db
          .select({ id: artwork.id })
          .from(artwork)
          .where(eq(artwork.storageKey, freshKey))
          .limit(1)
          .then((rows) => rows.length > 0)
          .catch(() => true);
        if (!referenced) await rm(freshTarget, { force: true }).catch(() => {});
      }
      throw error;
    });
  if (
    stored.previousTarget !== undefined &&
    stored.previousTarget !== stored.target
  )
    await rm(stored.previousTarget, { force: true }).catch(() => {});
  return stored.row;
}

/** A stored artwork original: exact bytes plus its artwork row. */
export interface ArtworkOriginal {
  bytes: Uint8Array;
  artwork: typeof artwork.$inferSelect;
}

/** Opens an artwork original without following a final symlink. */
export type ArtworkOpen = (path: string, flags: number) => Promise<FileHandle>;

/** Reads one colocated artwork original without following symlinks. */
export async function readArtworkOriginal(
  db: Database,
  artworkId: string,
  openFile: ArtworkOpen = open,
): Promise<ArtworkOriginal | null> {
  for (;;) {
    const [row] = await db
      .select()
      .from(artwork)
      .where(eq(artwork.id, artworkId));
    if (
      !row ||
      row.itemId === null ||
      row.backend !== "colocated" ||
      !row.selected
    )
      return null;
    const [item] = await db
      .select()
      .from(items)
      .where(eq(items.id, row.itemId));
    if (!item) return null;
    const [library] = await db
      .select()
      .from(libraries)
      .where(eq(libraries.id, item.libraryId));
    if (!library) return null;
    const { root, target } = resolveStoragePath(
      library.rootPath,
      row.storageKey,
    );
    await walkStorageDirectory(root, dirname(target), false);
    let handle: FileHandle;
    try {
      handle = await openFile(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const [current] = await db
          .select({ storageKey: artwork.storageKey })
          .from(artwork)
          .where(and(eq(artwork.id, artworkId), eq(artwork.selected, true)));
        if (current !== undefined && current.storageKey !== row.storageKey)
          continue;
        return null;
      }
      if (code === "ELOOP") throw new Error("Invalid artwork storage path.");
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile())
        throw new Error("Invalid artwork storage path.");
      return { bytes: new Uint8Array(await handle.readFile()), artwork: row };
    } finally {
      await handle.close();
    }
  }
}
