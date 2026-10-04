import { resolve } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  itemAncestors,
  items,
  libraryRoots,
  versions,
} from "../db/schema/index.ts";
import { type LibraryFile, readLibraryFile } from "./walker.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;

/** One root of a Library: its id and absolute path. */
export type LibraryRoot = Pick<typeof libraryRoots.$inferSelect, "id" | "path">;

/** A root-relative path in one root of a Library. */
export type RootedPath = { rootId: string; path: string };

/** One key per file across a Library's roots. */
export const rootedKey = (file: RootedPath) => `${file.rootId}:${file.path}`;

const rootFields = { id: libraryRoots.id, path: libraryRoots.path };

/** Lists a Library's roots, first root first. */
export function rootsOf(db: Connection, libraryId: string) {
  return db
    .select(rootFields)
    .from(libraryRoots)
    .where(eq(libraryRoots.libraryId, libraryId))
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id));
}

/** Reads one root's absolute path. */
export async function rootPath(db: Connection, rootId: string) {
  const [root] = await db
    .select({ path: libraryRoots.path })
    .from(libraryRoots)
    .where(eq(libraryRoots.id, rootId));
  if (root === undefined) throw new AuthError("NOT_FOUND");
  return root.path;
}

/** Joins a root-relative path to its root without touching the disk, for folders that may not exist yet. */
export async function absolutePath(
  db: Connection,
  at: { rootId: string; path: string },
) {
  return resolve(await rootPath(db, at.rootId), at.path);
}

/**
 * Stats a file under a root's absolute path without following links and
 * returns it with its absolute path. Throws `MissingLibraryPathError` when
 * it is gone.
 */
export async function locateIn(
  root: string,
  path: string,
): Promise<LibraryFile & { absolute: string }> {
  const found = await readLibraryFile(root, path);
  return { ...found, absolute: resolve(root, found.path) };
}

/** Locates a File, or any root-relative path, in its root; see `locateIn`. */
export async function locateFile(
  db: Connection,
  file: { rootId: string; path: string },
) {
  return locateIn(await rootPath(db, file.rootId), file.path);
}

/**
 * The root an Item's own writes go to, such as artwork and fetched
 * subtitles: the first root holding one of its imported Files or its
 * descendants', else its Library's first root.
 */
export async function homeRoot(
  db: Connection,
  itemId: string,
): Promise<LibraryRoot> {
  const [holding] = await db
    .select(rootFields)
    .from(itemAncestors)
    .innerJoin(files, eq(files.itemId, itemAncestors.descendantId))
    .innerJoin(
      versions,
      and(eq(versions.id, files.versionId), eq(versions.origin, "imported")),
    )
    .innerJoin(libraryRoots, eq(libraryRoots.id, files.rootId))
    .where(eq(itemAncestors.ancestorId, itemId))
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id))
    .limit(1);
  if (holding !== undefined) return holding;
  const [first] = await db
    .select(rootFields)
    .from(items)
    .innerJoin(libraryRoots, eq(libraryRoots.libraryId, items.libraryId))
    .where(eq(items.id, itemId))
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id))
    .limit(1);
  if (first === undefined) throw new AuthError("NOT_FOUND");
  return first;
}

/**
 * Where an Item's existing colocated assets may sit: its home root first,
 * then the rest of its Library's roots by position.
 */
export async function assetRoots(
  db: Connection,
  itemId: string,
): Promise<LibraryRoot[]> {
  const home = await homeRoot(db, itemId);
  const [item] = await db
    .select({ libraryId: items.libraryId })
    .from(items)
    .where(eq(items.id, itemId));
  if (item === undefined) throw new AuthError("NOT_FOUND");
  const roots = await rootsOf(db, item.libraryId);
  return [home, ...roots.filter((root) => root.id !== home.id)];
}
