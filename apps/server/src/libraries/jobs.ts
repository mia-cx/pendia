import { and, eq, isNull, sql } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  itemAncestors,
  items,
  type JobPayload,
  libraries,
  libraryRoots,
  probeCache,
  versions,
} from "../db/schema/index.ts";
import { createJobQueue, type Job } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { queueProviderFetch } from "../metadata/jobs.ts";
import { reconcileStoredVersions } from "../stored/reconcile.ts";
import { locateIn } from "./roots.ts";
import {
  isLibraryScan,
  libraryScanSource,
  type ScanSource,
  scanDirectory,
  scanScope,
  scanShowDirectory,
} from "./scan.ts";
import { persistScanTimelines } from "./timelines.ts";
import { MissingLibraryPathError } from "./walker.ts";

/** The concurrency key that serializes every job for one library. */
export function libraryConcurrencyKey(libraryId: string) {
  return `library:${libraryId}`;
}

/** The concurrency key serializing keyframe index reads of one library, separate from its scans. */
export function keyframesConcurrencyKey(libraryId: string) {
  return `keyframes:${libraryId}`;
}

/** Registers the built-in library scan and keyframe-index job handlers. */
export function registerLibraryJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
) {
  registry.register("scan", (payload, job) => runScanJob(db, payload, job));
  registry.register("keyframe-index", (payload) =>
    runKeyframeIndexJob(db, payload),
  );
}

/** Runs one scan job, reading files from the local disk unless a source is given. */
export async function runScanJob(
  db: Database,
  payload: Extract<JobPayload, { type: "scan" }>,
  job: Pick<Job, "id">,
  source?: ScanSource,
) {
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, payload.libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  const files = source ?? (await libraryScanSource(db, library));
  if (!isLibraryScan(payload)) {
    const options = {
      source: files,
      changes: payload.changes,
      reconcileMissing: payload.reconcileMissing,
    };
    // Every Item the directory scan wrote may need its own metadata fetch.
    const itemIds =
      library.medium === "movies"
        ? (await scanDirectory(db, library.id, payload.path, options)).itemIds
        : (await scanShowDirectory(db, library.id, payload.path, options))
            .itemIds;
    for (const itemId of itemIds) {
      // One fetch covers the whole Show, so a new pending Episode under a
      // matched Show queues it too.
      const [pending] = await db
        .select({ id: items.id })
        .from(items)
        .innerJoin(itemAncestors, eq(itemAncestors.descendantId, items.id))
        .where(
          and(
            eq(itemAncestors.ancestorId, itemId),
            eq(items.metadataState, "pending"),
          ),
        )
        .limit(1);
      if (pending !== undefined) await queueProviderFetch(db, itemId);
    }
    await reconcileStoredVersions(db, library, payload.path);
    await publishEvent(db, {
      kind: "library.changed",
      libraryId: library.id,
    });
    return;
  }
  const walked = await files.walk(".", true);
  const { rules } = scanScope(library.medium);
  const paths = new Set<string>();
  for (const file of walked) {
    const folder = rules.identify(file.path)?.canonicalFolder;
    if (folder !== undefined) paths.add(folder);
  }
  const existing = await db
    .select({ canonicalFolder: items.canonicalFolder })
    .from(items)
    .where(
      and(
        eq(items.libraryId, library.id),
        eq(items.kind, library.medium === "movies" ? "movie" : "show"),
        isNull(items.parentId),
      ),
    );
  for (const item of existing) paths.add(item.canonicalFolder);
  if (paths.size === 0) {
    await publishEvent(db, {
      kind: "library.changed",
      libraryId: library.id,
    });
    return;
  }
  const concurrencyKey = libraryConcurrencyKey(library.id);
  await db.transaction(async (tx) => {
    const queue = createJobQueue(tx);
    for (const path of paths)
      await queue.enqueue(
        {
          type: "scan",
          libraryId: library.id,
          path,
          reconcileMissing: true,
          runId: job.id,
        },
        { concurrencyKey },
      );
  });
}

/** How long a scan's probe cache entry and the file on disk must match for its index read to be applied. */
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
  });
}
