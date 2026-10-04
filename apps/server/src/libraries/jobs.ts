import { and, eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { items, type JobPayload, jobs, libraries } from "../db/schema/index.ts";
import { createJobQueue, type Job } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { groupMoviePaths } from "../mediums/movies.ts";
import { groupShowPaths } from "../mediums/shows.ts";
import {
  localScanSource,
  type ScanSource,
  scanDirectory,
  scanShowDirectory,
} from "./scan.ts";

/** The concurrency key that serializes every job for one library. */
export function libraryConcurrencyKey(libraryId: string) {
  return `library:${libraryId}`;
}

/** Registers the built-in library scan job handler. */
export function registerLibraryJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
) {
  registry.register("scan", (payload, job) => runScanJob(db, payload, job));
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
  const files = source ?? localScanSource(db, library);
  if (
    payload.path === "." &&
    payload.changes !== undefined &&
    payload.changes.length > 0
  )
    throw new AuthError("INVALID_INPUT");
  if (payload.path !== ".") {
    const options = {
      source: files,
      changes: payload.changes,
      reconcileMissing: payload.reconcileMissing,
    };
    if (library.medium === "movies") {
      const result = await scanDirectory(db, library.id, payload.path, options);
      if (result.itemId !== null) {
        const [item] = await db
          .select({ metadataState: items.metadataState })
          .from(items)
          .where(eq(items.id, result.itemId));
        if (!item) throw new AuthError("NOT_FOUND");
        if (item.metadataState === "pending") {
          const concurrencyKey = `provider:${result.itemId}`;
          // A running fetch never blocks: a pending Item after a provider
          // change earns one queued successor that replays the fetch.
          const [existing] = await db
            .select({ id: jobs.id })
            .from(jobs)
            .where(
              and(
                eq(jobs.type, "provider-fetch"),
                eq(jobs.concurrencyKey, concurrencyKey),
                eq(jobs.state, "queued"),
              ),
            )
            .limit(1);
          if (existing === undefined)
            await createJobQueue(db).enqueue(
              { type: "provider-fetch", itemId: result.itemId },
              { concurrencyKey },
            );
        }
      }
    } else {
      await scanShowDirectory(db, library.id, payload.path, options);
    }
    await publishEvent(db, {
      kind: "library.changed",
      libraryId: library.id,
    });
    return;
  }
  const walked = (await files.walk(".", true)).map((file) => file.path);
  const groups =
    library.medium === "movies"
      ? groupMoviePaths(walked)
      : groupShowPaths(walked);
  const paths = new Set(groups.map((group) => group.canonicalFolder));
  const existing = await db
    .select({ canonicalFolder: items.canonicalFolder })
    .from(items)
    .where(
      and(
        eq(items.libraryId, library.id),
        eq(items.kind, library.medium === "movies" ? "movie" : "show"),
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
