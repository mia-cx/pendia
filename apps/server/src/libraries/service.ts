import { isAbsolute, resolve } from "node:path";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  files,
  items,
  jobs,
  libraries,
  libraryRoots,
  scanFailures,
  versions,
} from "../db/schema/index.ts";
import type { DeletedArtworkFile } from "../db/tree.ts";
import { createJobQueue } from "../jobs/queue.ts";
import {
  type ArtworkStoreConfig,
  artworkStoreConfig,
} from "../metadata/artwork-backends.ts";
import { removeArtworkFiles } from "../metadata/artwork-store.ts";
import { removeFile } from "./changes.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import { rootsOf } from "./roots.ts";
import { pruneEmptiedItems } from "./scan.ts";
import { enqueueScan } from "./scan-payload.ts";

const maxNameLength = 128;

/** The advisory lock class serialising root writes, so overlap checks see every committed root. */
const rootsLockClass = 0x726f6f74;

const fields = {
  id: libraries.id,
  name: libraries.name,
  medium: libraries.medium,
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;

/** The writable fields accepted when a library is created. */
export type CreateLibraryInput = Pick<
  typeof libraries.$inferInsert,
  "name" | "medium"
> & { roots: readonly string[] };

/** A refused root: `root` is its index in the request, absent when the list as a whole is wrong. */
export class RootError extends Error {
  constructor(
    message: string,
    readonly root?: number,
  ) {
    super(message);
    this.name = "RootError";
  }
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > maxNameLength ||
    trimmed.includes("\0")
  )
    throw new AuthError("INVALID_INPUT");
  return trimmed;
}

/** Normalizes requested root paths: absolute, at least one. */
function normalizeRoots(paths: readonly string[]): string[] {
  if (paths.length === 0)
    throw new RootError("A library needs at least one folder.");
  return paths.map((path, index) => {
    if (path.trim().length < 1 || path.includes("\0") || !isAbsolute(path))
      throw new RootError("Enter an absolute path, like /srv/movies.", index);
    return resolve(path);
  });
}

const contains = (outer: string, inner: string) =>
  outer === inner ||
  inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);

const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);

/**
 * Refuses roots that equal or contain each other, or a root of another
 * Library, so a path always resolves to one root. Holds the roots lock until
 * the transaction ends.
 */
async function checkRoots(
  tx: Transaction,
  paths: readonly string[],
  libraryId?: string,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(${rootsLockClass}, 0)`);
  for (const [index, path] of paths.entries())
    if (paths.some((other, at) => at < index && overlaps(path, other)))
      throw new RootError(
        "This folder overlaps another folder of this library.",
        index,
      );
  const others = await tx
    .select({ path: libraryRoots.path, library: libraries.name })
    .from(libraryRoots)
    .innerJoin(libraries, eq(libraries.id, libraryRoots.libraryId))
    .where(
      libraryId === undefined
        ? undefined
        : ne(libraryRoots.libraryId, libraryId),
    );
  for (const [index, path] of paths.entries()) {
    const taken = others.find((other) => overlaps(path, other.path));
    if (taken !== undefined)
      throw new RootError(
        `This folder overlaps a folder of ${taken.library}.`,
        index,
      );
  }
}

/** Attaches each library's roots, first root first. */
async function withRoots<T extends { id: string }>(
  db: Connection,
  rows: readonly T[],
) {
  const roots =
    rows.length === 0
      ? []
      : await db
          .select({
            id: libraryRoots.id,
            libraryId: libraryRoots.libraryId,
            path: libraryRoots.path,
          })
          .from(libraryRoots)
          .where(
            inArray(
              libraryRoots.libraryId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(asc(libraryRoots.position), asc(libraryRoots.id));
  return rows.map((row) => ({
    ...row,
    roots: roots
      .filter((root) => root.libraryId === row.id)
      .map(({ id, path }) => ({ id, path })),
  }));
}

async function readLibrary(db: Connection, id: string) {
  const [library] = await withRoots(
    db,
    await db.select(fields).from(libraries).where(eq(libraries.id, id)),
  );
  if (!library) throw new AuthError("NOT_FOUND");
  return library;
}

/** Lists every library with its roots for a caller holding manage-libraries. */
export async function listLibraries(db: Database, actorId: string) {
  await requirePermission(db, actorId, "manage-libraries");
  return withRoots(
    db,
    await db
      .select(fields)
      .from(libraries)
      .orderBy(asc(libraries.name), asc(libraries.id)),
  );
}

/** Loads one library with its roots for a caller holding manage-libraries. */
export async function getLibrary(db: Database, actorId: string, id: string) {
  await requirePermission(db, actorId, "manage-libraries");
  return readLibrary(db, id);
}

/** Creates a library with one or more roots for a caller holding manage-libraries. */
export async function createLibrary(
  db: Database,
  actorId: string,
  input: CreateLibraryInput,
) {
  await requirePermission(db, actorId, "manage-libraries");
  const name = normalizeName(input.name);
  const paths = normalizeRoots(input.roots);
  return db.transaction(async (tx) => {
    await checkRoots(tx, paths);
    const [library] = await tx
      .insert(libraries)
      .values({ name, medium: input.medium })
      .returning(fields);
    if (!library) throw new Error("Library insert returned no row.");
    await tx.insert(libraryRoots).values(
      paths.map((path, position) => ({
        libraryId: library.id,
        path,
        position,
      })),
    );
    return readLibrary(tx, library.id);
  });
}

/**
 * What `updateLibrary` changes. `roots` is the whole new list, first root
 * first: an entry with an `id` repoints that root, one without adds a root,
 * and a root left out is removed with its Files.
 */
export type UpdateLibraryInput = {
  name?: string;
  roots?: readonly { id?: string; path: string }[];
};

/**
 * Removes roots and their Files, then the Items left without Files. Their
 * progress goes with them; Items another root still holds keep theirs.
 */
async function removeRoots(
  tx: Transaction,
  rootIds: readonly string[],
  deletedArtwork: DeletedArtworkFile[],
) {
  if (rootIds.length === 0) return;
  const held = await tx
    .select()
    .from(files)
    .where(inArray(files.rootId, [...rootIds]));
  const emptied: string[] = [];
  for (const file of held) {
    const itemId = await removeFile(tx, file);
    if (itemId !== undefined) emptied.push(itemId);
  }
  await pruneEmptiedItems(tx, emptied, deletedArtwork);
  await tx.delete(libraryRoots).where(inArray(libraryRoots.id, [...rootIds]));
}

/**
 * Renames a library and edits its roots for a caller holding
 * manage-libraries. It runs under the Library's row lock, which scans hold
 * while they write, and queues a full scan when a root was added or repointed.
 */
export async function updateLibrary(
  db: Database,
  actorId: string,
  id: string,
  input: UpdateLibraryInput,
) {
  await requirePermission(db, actorId, "manage-libraries");
  const name = input.name === undefined ? undefined : normalizeName(input.name);
  const requested =
    input.roots === undefined
      ? undefined
      : normalizeRoots(input.roots.map((root) => root.path)).map(
          (path, index) => ({ id: input.roots?.[index]?.id, path }),
        );
  const deletedArtwork: DeletedArtworkFile[] = [];
  const library = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, id))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
    if (name !== undefined)
      await tx.update(libraries).set({ name }).where(eq(libraries.id, id));
    if (requested === undefined) return readLibrary(tx, id);

    const current = new Map(
      (await rootsOf(tx, id)).map((root) => [root.id, root.path]),
    );
    const seen = new Set<string>();
    for (const [index, root] of requested.entries()) {
      if (root.id === undefined) continue;
      if (!current.has(root.id) || seen.has(root.id))
        throw new RootError("This folder is not part of this library.", index);
      seen.add(root.id);
    }
    await checkRoots(
      tx,
      requested.map((root) => root.path),
      id,
    );
    const removed = [...current.keys()].filter((rootId) => !seen.has(rootId));
    await removeRoots(tx, removed, deletedArtwork);
    const repointed = requested.filter(
      (root) => root.id !== undefined && current.get(root.id) !== root.path,
    );
    // Scans holding a roots snapshot from before this write refuse to write.
    if (
      removed.length > 0 ||
      repointed.length > 0 ||
      requested.some((root) => root.id === undefined)
    )
      await tx
        .update(libraries)
        .set({ rootsRevision: sql`${libraries.rootsRevision} + 1` })
        .where(eq(libraries.id, id));
    // Park repointed paths on their ids first, so two roots can swap paths.
    for (const root of repointed)
      if (root.id !== undefined)
        await tx
          .update(libraryRoots)
          .set({ path: root.id })
          .where(eq(libraryRoots.id, root.id));
    for (const [position, root] of requested.entries()) {
      if (root.id === undefined)
        await tx
          .insert(libraryRoots)
          .values({ libraryId: id, path: root.path, position });
      else
        await tx
          .update(libraryRoots)
          .set({ path: root.path, position })
          .where(eq(libraryRoots.id, root.id));
    }
    // One full scan covers every added and repointed root.
    if (repointed.length > 0 || requested.some((root) => root.id === undefined))
      await enqueueScan(
        createJobQueue(tx),
        { type: "scan", libraryId: id, path: "." },
        { concurrencyKey: libraryConcurrencyKey(id) },
      );
    return readLibrary(tx, id);
  });
  await removeArtworkFiles(deletedArtwork);
  return library;
}

/** Deletes a library row and its stored artwork, leaving the media folder untouched. */
export async function deleteLibrary(
  db: Database,
  actorId: string,
  id: string,
  store: ArtworkStoreConfig = artworkStoreConfig(),
) {
  await requirePermission(db, actorId, "manage-libraries");
  const orphaned = await db.transaction(async (tx) => {
    // The row lock serializes this snapshot against concurrent artwork stores.
    const [library] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, id))
      .for("update");
    if (!library) throw new AuthError("NOT_FOUND");
    // Colocated artwork sits in the media folder, so only other backends lose it.
    const stored = await tx
      .select({ backend: artwork.backend, storageKey: artwork.storageKey })
      .from(artwork)
      .leftJoin(items, eq(artwork.itemId, items.id))
      .leftJoin(versions, eq(artwork.versionId, versions.id))
      .where(
        and(
          ne(artwork.backend, "colocated"),
          or(eq(items.libraryId, id), eq(versions.libraryId, id)),
        ),
      );
    await tx.delete(libraries).where(eq(libraries.id, id));
    // Only colocated keys resolve in a root, and those are not removed here.
    return stored.map((row) => ({ ...row, rootPaths: [""] }));
  });
  await removeArtworkFiles(orphaned, store);
  return { ok: true };
}

/** Enqueues a full library scan for a caller holding manage-libraries. */
export async function scanLibrary(db: Database, actorId: string, id: string) {
  await requirePermission(db, actorId, "manage-libraries");
  const [library] = await db
    .select({ id: libraries.id, medium: libraries.medium })
    .from(libraries)
    .where(eq(libraries.id, id));
  if (!library) throw new AuthError("NOT_FOUND");
  const job = await enqueueScan(
    createJobQueue(db),
    { type: "scan", libraryId: id, path: "." },
    { concurrencyKey: libraryConcurrencyKey(id) },
  );
  return { jobId: job.id };
}

/** Reports one scan run's counts and newest job for a caller holding manage-libraries. */
export async function libraryScanStatus(
  db: Database,
  actorId: string,
  id: string,
  runId?: string,
) {
  await requirePermission(db, actorId, "manage-libraries");
  const [library] = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(eq(libraries.id, id));
  if (!library) throw new AuthError("NOT_FOUND");
  const where = and(
    eq(jobs.type, "scan"),
    sql`${jobs.payload}->>'libraryId' = ${id}`,
  );
  let run: string | null;
  let childJobIds: string[] = [];
  const rootScope = sql`${jobs.payload}->>'path' = '.' and ${jobs.payload}->>'runId' is null and ${jobs.payload}->'changes' is null`;
  if (runId === undefined) {
    const [root] = await db
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(and(where, rootScope))
      .orderBy(desc(jobs.id))
      .limit(1);
    run = root?.id ?? null;
    if (root?.payload.type === "scan")
      childJobIds = root.payload.childJobIds ?? [];
  } else {
    const [named] = await db
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(and(where, eq(jobs.id, runId), rootScope))
      .limit(1);
    if (!named) throw new AuthError("NOT_FOUND");
    run = named.id;
    if (named.payload.type === "scan")
      childJobIds = named.payload.childJobIds ?? [];
  }
  const empty = { queued: 0, running: 0, completed: 0, failed: 0 };
  if (run === null)
    return {
      libraryId: id,
      counts: empty,
      latest: null,
      runId: null,
      failures: await listScanFailures(db, id),
    };
  const runWhere = and(
    where,
    or(
      sql`(${jobs.id} = ${run}::uuid or ${jobs.payload}->>'runId' = ${run})`,
      childJobIds.length > 0 ? inArray(jobs.id, childJobIds) : undefined,
    ),
  );
  const grouped = await db
    .select({ state: jobs.state, count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(runWhere)
    .groupBy(jobs.state);
  const counts = { ...empty };
  for (const row of grouped) counts[row.state] = row.count;
  const [latest] = await db
    .select({ id: jobs.id, state: jobs.state, error: jobs.error })
    .from(jobs)
    .where(runWhere)
    .orderBy(desc(jobs.id))
    .limit(1);
  return {
    libraryId: id,
    counts,
    latest: latest ?? null,
    runId: run,
    failures: await listScanFailures(db, id, {
      where: runWhere,
      failed: counts.failed,
    }),
  };
}

/** The most failures a scan status lists; its total still counts them all. */
const listedFailures = 100;

/**
 * Lists, newest first, the files any scan of the library skipped and the
 * run's failed scan jobs. Skipped files stay until a rescan indexes them.
 */
async function listScanFailures(
  db: Database,
  libraryId: string,
  run?: { where: SQL | undefined; failed: number },
) {
  const files = await db
    .select({
      id: scanFailures.id,
      path: scanFailures.path,
      root: libraryRoots.path,
      reason: scanFailures.reason,
      detail: scanFailures.detail,
      at: scanFailures.failedAt,
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(scanFailures)
    .innerJoin(libraryRoots, eq(scanFailures.rootId, libraryRoots.id))
    .where(eq(libraryRoots.libraryId, libraryId))
    .orderBy(desc(scanFailures.failedAt), desc(scanFailures.id))
    .limit(listedFailures);
  // Jobs keep no finish time; a failed job's run_after is when its last attempt was due.
  const failedJobs = run
    ? await db
        .select({
          id: jobs.id,
          path: sql<string>`${jobs.payload}->>'path'`,
          error: jobs.error,
          at: jobs.runAfter,
        })
        .from(jobs)
        .where(and(run.where, eq(jobs.state, "failed")))
        .orderBy(desc(jobs.runAfter), desc(jobs.id))
        .limit(listedFailures)
    : [];
  const items = [
    ...files.map(({ total: _, at, ...row }) => ({
      kind: "file" as const,
      ...row,
      at: at.toISOString(),
    })),
    ...failedJobs.map((row) => ({
      kind: "job" as const,
      id: row.id,
      path: row.path,
      root: null,
      reason: "error" as const,
      detail: row.error ?? "",
      at: row.at.toISOString(),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return {
    total: (files[0]?.total ?? 0) + (run?.failed ?? 0),
    items: items.slice(0, listedFailures),
  };
}
