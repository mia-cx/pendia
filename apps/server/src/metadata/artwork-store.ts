import { open } from "node:fs/promises";
import type { MetadataResult } from "@thalia/plugin-api";
import { and, eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { artwork, items, libraries } from "../db/schema/index.ts";
import type { DeletedArtworkFile } from "../db/tree.ts";
import {
  assetRoots,
  firstInRoots,
  homeRoot,
  rootsOf,
} from "../libraries/roots.ts";
import {
  type ArtworkBackendName,
  type ArtworkOpen,
  type ArtworkStoreConfig,
  artworkBackend,
  artworkStoreConfig,
  type WrittenOriginal,
  writeArtworkOriginal,
} from "./artwork-backends.ts";
import { readBoundedBytes } from "./bounded-body.ts";

type ArtworkCandidate = MetadataResult["artwork"][number];

const maxArtworkDimension = 8192;
const maxArtworkPixels = 40_000_000;
const maxArtworkAspectRatio = 20;

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
  return readBoundedBytes(
    response.body,
    maxDownloadBytes,
    () => new Error("Artwork response too large."),
  );
}

/** Whether a stored original exists where its backend holds it; a colocated one may sit in any asset root. */
async function originalExists(
  db: Database,
  store: ArtworkStoreConfig,
  itemId: string,
  backendName: ArtworkBackendName,
  storageKey: string,
): Promise<boolean> {
  if (backendName === "colocated")
    return (
      (await firstInRoots(await assetRoots(db, itemId), async (root) =>
        (await artworkBackend(store, backendName, root.path)?.exists(
          storageKey,
        )) === true
          ? true
          : null,
      )) ?? false
    );
  const backend = artworkBackend(store, backendName, "");
  return backend !== null && (await backend.exists(storageKey));
}

/** Stores one selected artwork original in the process artwork store. */
export async function storeArtworkOriginal(
  db: Database,
  itemId: string,
  candidate: ArtworkCandidate,
  request: typeof fetch = fetch,
  {
    store = artworkStoreConfig(),
    timeoutMs = 30_000,
    maxDownloadBytes = 32 * 1024 * 1024,
  }: {
    store?: ArtworkStoreConfig;
    timeoutMs?: number;
    maxDownloadBytes?: number;
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid artwork request timeout.");
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < 1)
    throw new Error("Invalid artwork download limit.");
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new AuthError("NOT_FOUND");
  // Colocated originals live in the Item folder of its home root.
  const home = await homeRoot(db, itemId);

  const [selected] = await db
    .select()
    .from(artwork)
    .where(
      and(
        eq(artwork.itemId, itemId),
        eq(artwork.type, candidate.type),
        eq(artwork.selected, true),
      ),
    );
  if (
    selected !== undefined &&
    selected.sourceUrl === candidate.url &&
    (await originalExists(
      db,
      store,
      itemId,
      selected.backend,
      selected.storageKey,
    ))
  ) {
    return selected;
  }

  const response = await request(candidate.url, {
    headers: { accept: "image/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`Artwork request failed with status ${response.status}.`);
  const bytes = await readBoundedBody(response, maxDownloadBytes);
  let dimensions: { width: number; height: number };
  try {
    // metadata() reads the header only, so the size limits apply before decoding.
    const image = new Bun.Image(bytes);
    const { width, height } = await image.metadata();
    if (
      !Number.isInteger(width) ||
      width < 1 ||
      !Number.isInteger(height) ||
      height < 1
    )
      throw new Error("Invalid artwork response.");
    if (
      width > maxArtworkDimension ||
      height > maxArtworkDimension ||
      width * height > maxArtworkPixels ||
      Math.max(width, height) / Math.min(width, height) > maxArtworkAspectRatio
    )
      throw new Error("Invalid artwork response.");
    // A full decode rejects a truncated or corrupt file before it is stored.
    await image.resize(1).bytes();
    dimensions = { width, height };
  } catch {
    throw new Error("Invalid artwork response.");
  }

  // A replacement keeps the selected row's id, whichever backend held it.
  const candidateId = selected?.id ?? Bun.randomUUIDv7();
  const writeOriginal = (rootPath: string, itemFolder: string, id: string) =>
    writeArtworkOriginal(
      store,
      rootPath,
      itemFolder,
      `${id}.${Bun.randomUUIDv7()}`,
      bytes,
    );
  // Only colocated writes need the Item folder lock; a slow S3 PUT must hold no row lock.
  let fresh: WrittenOriginal | undefined =
    store.backend === "colocated"
      ? undefined
      : await writeOriginal(home.path, item.canonicalFolder, candidateId);
  const stored = await db
    .transaction(async (tx) => {
      const [lockedLibrary] = await tx
        .select()
        .from(libraries)
        .where(eq(libraries.id, item.libraryId))
        .for("update");
      if (!lockedLibrary) throw new AuthError("NOT_FOUND");
      const [locked] = await tx
        .select()
        .from(items)
        .where(eq(items.id, itemId))
        .for("update");
      if (!locked || locked.libraryId !== lockedLibrary.id)
        throw new AuthError("NOT_FOUND");

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
      const artworkId = selected?.id ?? candidateId;
      fresh ??= await writeOriginal(
        home.path,
        locked.canonicalFolder,
        artworkId,
      );
      const values = {
        sourceUrl: candidate.url,
        ...fresh,
        width: dimensions.width,
        height: dimensions.height,
        selected: true,
      };

      if (selected) {
        const [row] = await tx
          .update(artwork)
          .set(values)
          .where(eq(artwork.id, selected.id))
          .returning();
        if (!row) throw new Error("Artwork update returned no row.");
        return { row, previous: selected };
      }
      const [row] = await tx
        .insert(artwork)
        .values({
          id: artworkId,
          itemId,
          versionId: null,
          type: candidate.type,
          ...values,
        })
        .returning();
      if (!row) throw new Error("Artwork insertion returned no row.");
      return { row, previous: undefined };
    })
    .catch(async (error: unknown) => {
      if (fresh !== undefined) {
        const referenced = await db
          .select({ id: artwork.id })
          .from(artwork)
          .where(eq(artwork.storageKey, fresh.storageKey))
          .limit(1)
          .then((rows) => rows.length > 0)
          .catch(() => true);
        if (!referenced)
          await removeArtworkFiles(
            [{ ...fresh, rootPaths: [home.path] }],
            store,
          );
      }
      throw error;
    });
  const { previous } = stored;
  if (previous !== undefined && previous.storageKey !== stored.row.storageKey)
    await removeArtworkFiles(
      [
        {
          ...previous,
          // The replaced original may sit in any root the Item's Library has.
          rootPaths: (await rootsOf(db, item.libraryId)).map(
            (root) => root.path,
          ),
        },
      ],
      store,
    );
  return stored.row;
}

/** Removes committed artwork originals from their backends without failing the database operation. */
export async function removeArtworkFiles(
  files: readonly DeletedArtworkFile[],
  store: ArtworkStoreConfig = artworkStoreConfig(),
): Promise<void> {
  for (const entry of files) {
    // Only colocated keys resolve in a root; other backends hold one copy.
    const rootPaths =
      entry.backend === "colocated"
        ? entry.rootPaths
        : entry.rootPaths.slice(0, 1);
    for (const rootPath of rootPaths) {
      try {
        await artworkBackend(store, entry.backend, rootPath)?.remove(
          entry.storageKey,
        );
      } catch {
        // Best effort: a committed database delete is never reported as rolled back.
      }
    }
  }
}

/** Removes selected artwork after committing its database row deletion. */
export async function removeSelectedArtwork(
  db: Database,
  itemId: string,
  type: ArtworkCandidate["type"],
  store: ArtworkStoreConfig = artworkStoreConfig(),
): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
    const rootPaths = (await rootsOf(tx, locked.libraryId)).map(
      (root) => root.path,
    );
    const [selected] = await tx
      .select()
      .from(artwork)
      .where(
        and(
          eq(artwork.itemId, itemId),
          eq(artwork.type, type),
          eq(artwork.selected, true),
        ),
      );
    if (!selected) return undefined;
    await tx.delete(artwork).where(eq(artwork.id, selected.id));
    return {
      backend: selected.backend,
      rootPaths,
      storageKey: selected.storageKey,
    };
  });
  if (removed === undefined) return false;
  await removeArtworkFiles([removed], store);
  return true;
}

/** Finds the id of an Item's selected artwork of a type, if it has one. */
export async function selectedArtworkId(
  db: Database,
  itemId: string,
  type: string,
): Promise<string | undefined> {
  const [selected] = await db
    .select({ id: artwork.id })
    .from(artwork)
    .where(
      and(
        eq(artwork.itemId, itemId),
        eq(artwork.type, type),
        eq(artwork.selected, true),
      ),
    )
    .limit(1);
  return selected?.id;
}

/** A stored artwork original: exact bytes plus its artwork row. */
export interface ArtworkOriginal {
  bytes: Uint8Array;
  artwork: typeof artwork.$inferSelect;
}

/** Reads one selected Item artwork original from whichever backend holds it. */
export async function readArtworkOriginal(
  db: Database,
  artworkId: string,
  store: ArtworkStoreConfig = artworkStoreConfig(),
  openFile: ArtworkOpen = open,
): Promise<ArtworkOriginal | null> {
  for (;;) {
    const [row] = await db
      .select()
      .from(artwork)
      .where(eq(artwork.id, artworkId));
    if (!row || row.itemId === null || !row.selected) return null;
    if (row.backend === "colocated") {
      const roots = await assetRoots(db, row.itemId).catch((error: unknown) => {
        if (error instanceof AuthError) return null;
        throw error;
      });
      if (roots === null) return null;
      // The home root moved since the write: try each root the file may be in.
      const bytes = await firstInRoots(
        roots,
        async (root) =>
          (await artworkBackend(store, "colocated", root.path, openFile)?.read(
            row.storageKey,
          )) ?? null,
      );
      if (bytes !== null) return { bytes, artwork: row };
    } else {
      const bytes = await artworkBackend(
        store,
        row.backend,
        "",
        openFile,
      )?.read(row.storageKey);
      if (bytes != null) return { bytes, artwork: row };
    }
    // A concurrent replacement may have removed this generation; follow it.
    const [current] = await db
      .select({ storageKey: artwork.storageKey })
      .from(artwork)
      .where(and(eq(artwork.id, artworkId), eq(artwork.selected, true)));
    if (current === undefined || current.storageKey === row.storageKey)
      return null;
  }
}
