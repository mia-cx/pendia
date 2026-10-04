import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { browseCardsById } from "../api/items.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  items,
  jobs,
  libraries,
  segmentTimelines,
  versions,
} from "../db/schema/index.ts";
import { segmentCount } from "../playback/playlists.ts";
import { storedFolderOf } from "./jobs.ts";

/** How many queued store jobs a status read names; the rest are only counted. */
export const queuedStoreListLimit = 10;

const segmentName = /^\d+\.m4s$/;

// Sweeps share the job type; only encodes name a source File.
const encodeJob = and(
  eq(jobs.type, "store"),
  sql`${jobs.payload} ? 'sourceFileId'`,
);

async function storeJobs(db: Database, state: "queued" | "running") {
  const query = db
    .select({
      jobId: jobs.id,
      rung: sql<string>`${jobs.payload}->>'rung'`,
      runAfter: jobs.runAfter,
      itemId: files.itemId,
      path: files.path,
      rootPath: libraries.rootPath,
      boundariesSeconds: segmentTimelines.boundariesSeconds,
    })
    .from(jobs)
    .innerJoin(
      files,
      sql`${files.id} = (${jobs.payload}->>'sourceFileId')::uuid`,
    )
    .innerJoin(items, eq(items.id, files.itemId))
    .innerJoin(libraries, eq(libraries.id, items.libraryId))
    .innerJoin(versions, eq(versions.id, files.versionId))
    .leftJoin(
      segmentTimelines,
      eq(segmentTimelines.id, versions.segmentTimelineId),
    )
    .where(and(encodeJob, eq(jobs.state, state)))
    .orderBy(asc(jobs.runAfter), asc(jobs.id));
  return state === "queued" ? query.limit(queuedStoreListLimit) : query;
}

// A rung folder holds only finished segments; ffmpeg writes into `.partial`.
async function segmentsDone(folder: string) {
  try {
    return (await readdir(folder)).filter((name) => segmentName.test(name))
      .length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return 0;
    throw error;
  }
}

/** Reads store job progress for a caller holding manage-transcoding: running encodes with segment counts, and the queue. */
export async function readStoreStatus(db: Database, actorId: string) {
  await requirePermission(db, actorId, "manage-transcoding");
  const running = await storeJobs(db, "running");
  const queued = await storeJobs(db, "queued");
  const [total] = await db
    .select({ value: count() })
    .from(jobs)
    .where(and(encodeJob, eq(jobs.state, "queued")));
  const cards = new Map(
    (
      await browseCardsById(db, [
        ...new Set([...running, ...queued].map((job) => job.itemId)),
      ])
    ).map((card) => [card.id, card]),
  );
  const withItem = <T extends { itemId: string }>(rows: readonly T[]) =>
    rows.flatMap((row) => {
      const item = cards.get(row.itemId);
      return item === undefined ? [] : [{ ...row, item }];
    });
  return {
    running: await Promise.all(
      withItem(running).map(async (job) => ({
        jobId: job.jobId,
        item: job.item,
        rung: job.rung,
        segmentsDone: await segmentsDone(
          resolve(job.rootPath, storedFolderOf(job.path, job.rung)),
        ),
        segmentsTotal:
          job.boundariesSeconds === null
            ? 0
            : segmentCount(job.boundariesSeconds),
      })),
    ),
    queued: {
      total: total?.value ?? 0,
      next: withItem(queued).map((job) => ({
        jobId: job.jobId,
        item: job.item,
        rung: job.rung,
        runAfter: job.runAfter.toISOString(),
      })),
    },
  };
}
