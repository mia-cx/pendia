import { eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { files, items, libraries } from "../db/schema/index.ts";
import {
  readStoredVersionPolicy,
  rungFits,
  type StoredVersionPolicy,
} from "./policy.ts";
import {
  bestSources,
  reconcileStoredVersions,
  requestStore,
} from "./reconcile.ts";

async function loadLibrary(db: Database, id: string) {
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, id))
    .limit(1);
  if (library === undefined) throw new AuthError("NOT_FOUND");
  return library;
}

/** Reads a library's stored-version policy for a caller holding manage-transcoding. */
export async function getStoredVersionPolicy(
  db: Database,
  actorId: string,
  libraryId: string,
) {
  await requirePermission(db, actorId, "manage-transcoding");
  const library = await loadLibrary(db, libraryId);
  return { policy: readStoredVersionPolicy(library.configuration) };
}

/** Replaces a library's stored-version policy, null to store nothing, then reconciles the library. */
export async function setStoredVersionPolicy(
  db: Database,
  actorId: string,
  libraryId: string,
  policy: StoredVersionPolicy | null,
) {
  await requirePermission(db, actorId, "manage-transcoding");
  // The row lock keeps a concurrent configuration write from being lost.
  const library = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (current === undefined) throw new AuthError("NOT_FOUND");
    const { storedVersions: _previous, ...rest } = current.configuration;
    // A JSON round trip turns the decoded readonly policy into plain JSON.
    const storedVersions: JsonObject = JSON.parse(JSON.stringify(policy));
    const configuration = policy === null ? rest : { ...rest, storedVersions };
    const [updated] = await tx
      .update(libraries)
      .set({ configuration })
      .where(eq(libraries.id, libraryId))
      .returning();
    if (updated === undefined) throw new AuthError("NOT_FOUND");
    return updated;
  });
  await reconcileStoredVersions(db, library);
  return { policy: readStoredVersionPolicy(library.configuration) };
}

/** Queues one policy rung for an Item whatever the policy condition says; false when it is complete or already queued. */
export async function requestStoredVersion(
  db: Database,
  actorId: string,
  itemId: string,
  rungName: string,
) {
  await requirePermission(db, actorId, "manage-transcoding");
  const [item] = await db
    .select({ libraryId: items.libraryId })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (item === undefined) throw new AuthError("NOT_FOUND");
  const library = await loadLibrary(db, item.libraryId);
  // Rungs are defined by the policy; a manual request only skips its condition.
  const rung = readStoredVersionPolicy(library.configuration)?.rungs.find(
    (candidate) => candidate.name === rungName,
  );
  if (rung === undefined) throw new AuthError("INVALID_INPUT");
  const source = (await bestSources(db, eq(files.itemId, itemId))).get(itemId);
  if (source === undefined || !rungFits(rung, source.video))
    throw new AuthError("CONFLICT");
  return { queued: await requestStore(db, source.fileId, rung.name) };
}
