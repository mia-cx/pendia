import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
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

async function ensureRealDirectory(root: string, directory: string) {
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

/** Stores one selected artwork original in the Item's colocated backend. */
export async function storeArtworkOriginal(
  db: Database,
  itemId: string,
  candidate: ArtworkCandidate,
  request: typeof fetch = fetch,
) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new AuthError("NOT_FOUND");
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, item.libraryId));
  if (!library) throw new AuthError("NOT_FOUND");

  const response = await request(candidate.url, {
    headers: { accept: "image/*" },
  });
  if (!response.ok)
    throw new Error(`Artwork request failed with status ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());

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
  const reused = selected?.backend === "colocated" ? selected : undefined;
  const artworkId = reused?.id ?? Bun.randomUUIDv7();
  const storageKey =
    reused?.storageKey ??
    `${item.canonicalFolder}/.pendia/artwork/${artworkId}`;
  const { root, target } = resolveStoragePath(library.rootPath, storageKey);
  await ensureRealDirectory(root, dirname(target));
  const temporary = `${target}.${Bun.randomUUIDv7()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return db.transaction(async (tx) => {
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
          selected: true,
        })
        .where(eq(artwork.id, reused.id))
        .returning();
      if (!row) throw new Error("Artwork update returned no row.");
      return row;
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
        width: null,
        height: null,
        selected: true,
      })
      .returning();
    if (!row) throw new Error("Artwork insertion returned no row.");
    return row;
  });
}
