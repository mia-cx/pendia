import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { items, jobs, libraries } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import {
  type LibraryDirectory,
  MissingLibraryPathError,
  walkLibraryDirectories,
} from "./walker.ts";

/** Options for the scheduled directory-mtime repair pass. */
export type RepairOptions = {
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

type TrackedJob = { jobId: string; modifiedNs: bigint | undefined };

/** Creates the startup and nightly library repair pass. */
export function createLibraryRepair(db: Database, options: RepairOptions = {}) {
  const intervalMs = options.intervalMs ?? 86_400_000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > 2_147_483_647
  ) {
    throw new Error(
      "Repair interval must be a positive safe integer within the timer limit.",
    );
  }
  const onError = options.onError ?? (() => {});
  const snapshots = new Map<string, Map<string, bigint>>();
  const trackedJobs = new Map<string, Map<string, TrackedJob>>();
  let active: Promise<number> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const report = (error: unknown) => {
    try {
      onError(error);
    } catch {}
  };

  async function runOnce(): Promise<number> {
    const rows = await db
      .select()
      .from(libraries)
      .where(eq(libraries.medium, "movies"));
    const planned: {
      libraryId: string;
      next: Map<string, bigint>;
      scans: Map<string, bigint | undefined>;
    }[] = [];
    for (const library of rows) {
      const walked = new Map<string, LibraryDirectory>();
      try {
        for await (const directory of walkLibraryDirectories(
          library.rootPath,
          moviesMedium.scan,
        )) {
          walked.set(directory.path, directory);
        }
      } catch (error) {
        if (
          error instanceof MissingLibraryPathError &&
          error.scope === "root"
        ) {
          continue;
        }
        throw error;
      }
      const previous = snapshots.get(library.id) ?? new Map<string, bigint>();
      const perLibrary =
        trackedJobs.get(library.id) ?? new Map<string, TrackedJob>();
      const live = new Set<string>();
      const retry = new Set<string>();
      if (perLibrary.size > 0) {
        const jobRows = await db
          .select({ id: jobs.id, state: jobs.state })
          .from(jobs)
          .where(
            inArray(
              jobs.id,
              [...perLibrary.values()].map((entry) => entry.jobId),
            ),
          );
        const stateById = new Map(jobRows.map((row) => [row.id, row.state]));
        for (const [path, entry] of perLibrary) {
          const state = stateById.get(entry.jobId);
          if (state === "completed") {
            if (entry.modifiedNs === undefined) previous.delete(path);
            else previous.set(path, entry.modifiedNs);
            perLibrary.delete(path);
          } else if (state === "queued" || state === "running") {
            live.add(path);
          } else {
            retry.add(path);
          }
        }
      }
      const next = new Map<string, bigint>();
      const changed = new Map<string, string[]>();
      for (const [path, directory] of walked) {
        if (previous.get(path) === directory.modifiedNs) {
          next.set(path, directory.modifiedNs);
        } else {
          changed.set(
            path,
            groupMoviePaths(directory.files).map(
              (group) => group.canonicalFolder,
            ),
          );
        }
      }
      const existing = await db
        .select({ canonicalFolder: items.canonicalFolder })
        .from(items)
        .where(and(eq(items.libraryId, library.id), eq(items.kind, "movie")));
      const itemFolders = new Set(existing.map((item) => item.canonicalFolder));
      const scans = new Map<string, bigint | undefined>();
      for (const [path, folders] of changed) {
        const directory = walked.get(path);
        if (!directory) continue;
        const needsScan = folders.length > 0 || itemFolders.has(path);
        if (!needsScan) {
          next.set(path, directory.modifiedNs);
          continue;
        }
        const acknowledged = previous.get(path);
        if (acknowledged !== undefined) next.set(path, acknowledged);
        for (const folder of folders) {
          scans.set(folder, directory.modifiedNs);
        }
        if (itemFolders.has(path)) scans.set(path, directory.modifiedNs);
      }
      for (const path of itemFolders) {
        if (!walked.has(path) && !scans.has(path)) scans.set(path, undefined);
      }
      for (const path of retry) {
        scans.set(path, walked.get(path)?.modifiedNs);
      }
      for (const path of live) {
        scans.delete(path);
      }
      planned.push({ libraryId: library.id, next, scans });
    }
    let enqueued = 0;
    const recorded: {
      libraryId: string;
      path: string;
      entry: TrackedJob;
    }[] = [];
    await db.transaction(async (tx) => {
      const queue = createJobQueue(tx);
      for (const plan of planned) {
        for (const [path, modifiedNs] of plan.scans) {
          const job = await queue.enqueue(
            { type: "scan", libraryId: plan.libraryId, path },
            { concurrencyKey: libraryConcurrencyKey(plan.libraryId) },
          );
          recorded.push({
            libraryId: plan.libraryId,
            path,
            entry: { jobId: job.id, modifiedNs },
          });
          enqueued += 1;
        }
      }
    });
    for (const plan of planned) snapshots.set(plan.libraryId, plan.next);
    for (const record of recorded) {
      let perLibrary = trackedJobs.get(record.libraryId);
      if (perLibrary === undefined) {
        perLibrary = new Map();
        trackedJobs.set(record.libraryId, perLibrary);
      }
      perLibrary.set(record.path, record.entry);
    }
    return enqueued;
  }

  function run(): Promise<number> {
    active ??= runOnce().finally(() => {
      active = undefined;
    });
    return active;
  }

  return {
    run,
    start() {
      if (stopped || timer !== undefined) return;
      run().catch(report);
      timer = setInterval(() => {
        run().catch(report);
      }, intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await active?.catch(() => {});
    },
  };
}
