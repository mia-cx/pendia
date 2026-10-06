import { and, eq, isNull } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  itemAncestors,
  items,
  type JobPayload,
  libraries,
} from "../db/schema/index.ts";
import { createJobQueue, type Job } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { queueProviderFetch } from "../metadata/jobs.ts";
import { reconcileStoredVersions } from "../stored/reconcile.ts";
import { runKeyframeIndexJob } from "./keyframe-index.ts";
import {
  isLibraryScan,
  libraryScanSource,
  type ScanSource,
  scanDirectory,
  scanScope,
  scanShowDirectory,
} from "./scan.ts";

/** The concurrency key that serializes every job for one library. */
export function libraryConcurrencyKey(libraryId: string) {
  return `library:${libraryId}`;
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
