import { posix } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  files,
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
  if (target === undefined) return;
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
  if (!indexed) return;
  // The index may make stored outputs eligible; run the same reconciliation
  // the scan runs, scoped to the file's folder.
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, payload.libraryId));
  if (library !== undefined) {
    await reconcileStoredVersions(db, library, posix.dirname(payload.path));
  }
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

/**
 * Pushes a file's index job to the front: a queued job's priority rises to 10,
 * a running one is left alone, and nothing queued a fresh one at priority 10.
 * Repeated calls never create a second job.
 */
export async function requestKeyframeIndex(
  db: Database,
  payload: Omit<Extract<JobPayload, { type: "keyframe-index" }>, "type">,
) {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: jobs.id, state: jobs.state })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "keyframe-index"),
          inArray(jobs.state, ["queued", "running"]),
          sql`${jobs.payload}->>'rootId' = ${payload.rootId}`,
          sql`${jobs.payload}->>'path' = ${payload.path}`,
        ),
      )
      .limit(1);
    if (existing?.state === "running") return;
    if (existing !== undefined) {
      await tx
        .update(jobs)
        .set({ priority: sql`greatest(${jobs.priority}, 10)` })
        .where(eq(jobs.id, existing.id));
      return;
    }
    await createJobQueue(tx).enqueue(
      { type: "keyframe-index", ...payload },
      {
        priority: 10,
        concurrencyKey: keyframesConcurrencyKey(payload.libraryId),
      },
    );
  });
}
