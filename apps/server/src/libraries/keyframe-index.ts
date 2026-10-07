import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  files,
  items,
  type JobPayload,
  jobs,
  libraries,
  libraryRoots,
  probeCache,
  versions,
} from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { reconcileStoredVersions } from "../stored/reconcile.ts";
import { locateIn } from "./roots.ts";
import { persistScanTimelines } from "./timelines.ts";
import { MissingLibraryPathError } from "./walker.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The concurrency key serializing keyframe index reads of one library, separate from its scans. */
export function keyframesConcurrencyKey(libraryId: string) {
  return `keyframes:${libraryId}`;
}

/** The probe cache entry and on-disk stats a job's file must match for its index read to apply. */
type LocatedIndexTarget = {
  rootId: string;
  rootPath: string;
  path: string;
  absolute: string;
  bytes: bigint;
  modifiedNs: bigint;
};

/** Locates the job's file and reads the cache entry that names it; undefined when either is gone, stale or already indexed. */
async function indexTarget(
  db: Database,
  payload: Extract<JobPayload, { type: "keyframe-index" }>,
): Promise<LocatedIndexTarget | undefined> {
  const [root] = await db
    .select({ id: libraryRoots.id, path: libraryRoots.path })
    .from(libraryRoots)
    .where(
      and(
        eq(libraryRoots.id, payload.rootId),
        eq(libraryRoots.libraryId, payload.libraryId),
      ),
    );
  if (!root) return undefined;
  const located = await locateIn(root.path, payload.path).catch(
    (error: unknown) => {
      if (error instanceof MissingLibraryPathError) return undefined;
      throw error;
    },
  );
  if (!located) return undefined;
  const [entry] = await db
    .select()
    .from(probeCache)
    .where(
      and(eq(probeCache.rootId, root.id), eq(probeCache.path, located.path)),
    );
  if (
    entry === undefined ||
    entry.result.keyframesSeconds !== undefined ||
    entry.bytes !== located.bytes ||
    entry.modifiedNs !== located.modifiedNs
  )
    return undefined;
  return {
    rootId: root.id,
    rootPath: root.path,
    path: located.path,
    absolute: located.absolute,
    bytes: located.bytes,
    modifiedNs: located.modifiedNs,
  };
}

/**
 * Reads one scanned file's container keyframe index outside any transaction,
 * then applies it to the probe cache entry and the Version its File belongs
 * to, deriving the Item's segment timelines like the scan used to. A file
 * that changed, vanished or was already indexed settles as a no-op.
 */
export async function runKeyframeIndexJob(
  db: Database,
  payload: Extract<JobPayload, { type: "keyframe-index" }>,
  readIndex: typeof readKeyframeIndex = readKeyframeIndex,
) {
  const target = await indexTarget(db, payload);
  if (target === undefined) {
    // A retry after the index committed still owes the stored handoff.
    if (await alreadyIndexed(db, payload)) await reconcileItems(db, payload);
    return;
  }
  const { keyframesSeconds } = await readIndex(target.absolute);
  const still = await indexTarget(db, payload);
  if (
    still === undefined ||
    still.bytes !== target.bytes ||
    still.modifiedNs !== target.modifiedNs
  )
    return;
  let indexed = false;
  await db.transaction(async (tx) => {
    // The per-file lock probeLibraryFile takes, then the scan's library lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${target.rootId}:${target.path}`}, 0))`,
    );
    const [locked] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, payload.libraryId))
      .for("update");
    if (!locked) return;
    const [entry] = await tx
      .select()
      .from(probeCache)
      .where(
        and(
          eq(probeCache.rootId, target.rootId),
          eq(probeCache.path, target.path),
        ),
      );
    if (
      entry === undefined ||
      entry.result.keyframesSeconds !== undefined ||
      entry.bytes !== target.bytes ||
      entry.modifiedNs !== target.modifiedNs
    )
      return;
    await tx
      .update(probeCache)
      .set({ result: { ...entry.result, keyframesSeconds } })
      .where(eq(probeCache.id, entry.id));
    const touched = await tx
      .select({ versionId: files.versionId, itemId: files.itemId })
      .from(files)
      .where(and(eq(files.rootId, target.rootId), eq(files.path, target.path)));
    const itemIds = new Set<string>();
    for (const { versionId, itemId } of touched) {
      await tx
        .update(versions)
        .set({ keyframesSeconds, lazyIndexPending: false })
        .where(
          and(eq(versions.id, versionId), eq(versions.lazyIndexPending, true)),
        );
      itemIds.add(itemId);
    }
    for (const itemId of itemIds) await persistScanTimelines(tx, itemId);
    indexed = true;
  });
  if (indexed) await reconcileItems(db, payload);
}

/** Whether the job's file already carries a read index (an array, or null for an unsupported container). */
async function alreadyIndexed(
  db: Database,
  payload: Extract<JobPayload, { type: "keyframe-index" }>,
) {
  const [entry] = await db
    .select({ result: probeCache.result })
    .from(probeCache)
    .where(
      and(
        eq(probeCache.rootId, payload.rootId),
        eq(probeCache.path, payload.path),
      ),
    );
  return entry !== undefined && entry.result.keyframesSeconds !== undefined;
}

/**
 * Runs the scan's stored-policy reconciliation over every Item the file
 * belongs to. A new timeline aligns every Version of the cut, including ones
 * in sibling folders, so the Item's whole folder is in scope. Idempotent.
 */
async function reconcileItems(
  db: Database,
  payload: Extract<JobPayload, { type: "keyframe-index" }>,
) {
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, payload.libraryId));
  if (library === undefined) return;
  const folders = await db
    .selectDistinct({ folder: items.canonicalFolder })
    .from(files)
    .innerJoin(items, eq(items.id, files.itemId))
    .where(and(eq(files.rootId, payload.rootId), eq(files.path, payload.path)));
  for (const { folder } of folders)
    await reconcileStoredVersions(db, library, folder);
}

/**
 * Queues one index job per file, unless a queued one already names it. A
 * running job is no reason to skip: its read may predate a file replacement,
 * and a duplicate for an unchanged file no-ops quickly in indexTarget.
 */
export async function queueKeyframeIndex(
  tx: Transaction,
  payload: Omit<Extract<JobPayload, { type: "keyframe-index" }>, "type">,
) {
  const [existing] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "keyframe-index"),
        eq(jobs.state, "queued"),
        sql`${jobs.payload}->>'rootId' = ${payload.rootId}`,
        sql`${jobs.payload}->>'path' = ${payload.path}`,
      ),
    )
    .limit(1);
  if (existing) return;
  await createJobQueue(tx).enqueue(
    { type: "keyframe-index", ...payload },
    {
      priority: -5,
      concurrencyKey: keyframesConcurrencyKey(payload.libraryId),
    },
  );
}
