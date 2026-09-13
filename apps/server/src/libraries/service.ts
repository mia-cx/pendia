import { isAbsolute, resolve } from "node:path";
import { asc, eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { libraries } from "../db/schema/index.ts";
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
