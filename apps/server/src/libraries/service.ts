import { isAbsolute, resolve } from "node:path";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { jobs, libraries } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { libraryConcurrencyKey } from "./jobs.ts";

const maxNameLength = 128;

const fields = {
  id: libraries.id,
  name: libraries.name,
  medium: libraries.medium,
  rootPath: libraries.rootPath,
};

/** The writable fields accepted when a library is created. */
export type CreateLibraryInput = Pick<
  typeof libraries.$inferInsert,
  "name" | "medium" | "rootPath"
>;

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

function normalizeRoot(rootPath: string): string {
  if (
    rootPath.trim().length < 1 ||
    rootPath.includes("\0") ||
    !isAbsolute(rootPath)
  )
    throw new AuthError("INVALID_INPUT");
  return resolve(rootPath);
}

/** Lists every library for a caller holding manage-libraries. */
export async function listLibraries(db: Database, actorId: string) {
  await requirePermission(db, actorId, "manage-libraries");
  return db
    .select(fields)
    .from(libraries)
    .orderBy(asc(libraries.name), asc(libraries.id));
}

/** Loads one library for a caller holding manage-libraries. */
export async function getLibrary(db: Database, actorId: string, id: string) {
  await requirePermission(db, actorId, "manage-libraries");
  const [library] = await db
    .select(fields)
    .from(libraries)
    .where(eq(libraries.id, id));
  if (!library) throw new AuthError("NOT_FOUND");
  return library;
}

/** Creates a library for a caller holding manage-libraries. */
export async function createLibrary(
  db: Database,
  actorId: string,
  input: CreateLibraryInput,
) {
  await requirePermission(db, actorId, "manage-libraries");
  const name = normalizeName(input.name);
  const rootPath = normalizeRoot(input.rootPath);
  const [library] = await db
    .insert(libraries)
    .values({ name, medium: input.medium, rootPath })
    .returning(fields);
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

/** Renames a library for a caller holding manage-libraries. */
export async function updateLibrary(
  db: Database,
  actorId: string,
  id: string,
  input: { name: string },
) {
  await requirePermission(db, actorId, "manage-libraries");
  const name = normalizeName(input.name);
  const [library] = await db
    .update(libraries)
    .set({ name })
    .where(eq(libraries.id, id))
    .returning(fields);
  if (!library) throw new AuthError("NOT_FOUND");
  return library;
}

/** Deletes a library row without touching the filesystem. */
export async function deleteLibrary(db: Database, actorId: string, id: string) {
  await requirePermission(db, actorId, "manage-libraries");
  const [deleted] = await db
    .delete(libraries)
    .where(eq(libraries.id, id))
    .returning({ id: libraries.id });
  if (!deleted) throw new AuthError("NOT_FOUND");
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
  const job = await createJobQueue(db).enqueue(
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
  if (runId === undefined) {
    const [root] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(where, sql`${jobs.payload}->>'path' = '.'`))
      .orderBy(desc(jobs.id))
      .limit(1);
    run = root?.id ?? null;
  } else {
    const [named] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(where, eq(jobs.id, runId)))
      .limit(1);
    if (!named) throw new AuthError("NOT_FOUND");
    run = named.id;
  }
  const empty = { queued: 0, running: 0, completed: 0, failed: 0 };
  if (run === null)
    return { libraryId: id, counts: empty, latest: null, runId: null };
  const runWhere = and(
    where,
    sql`(${jobs.id} = ${run}::uuid or ${jobs.payload}->>'runId' = ${run})`,
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
  return { libraryId: id, counts, latest: latest ?? null, runId: run };
}
