import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { items, jobs, libraries } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { groupShowPaths, showsScan } from "../mediums/shows.ts";
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

type SnapshotUpdate = { path: string; modifiedNs: bigint | undefined };
type TrackedJob = { jobId: string; updates: SnapshotUpdate[] };
type ReservedConnection = Awaited<ReturnType<Database["$client"]["reserve"]>>;

const repairLockKey = 0x70656e6469617270n;

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
  let leader: ReservedConnection | undefined;
  let electing: Promise<void> | undefined;
  let electionTimer: ReturnType<typeof setTimeout> | undefined;
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
      .where(inArray(libraries.medium, ["movies", "shows"]));
    const planned: {
      libraryId: string;
      next: Map<string, bigint>;
      scans: Map<string, Map<string, bigint | undefined>>;
    }[] = [];
    for (const library of rows) {
      const medium =
        library.medium === "movies"
          ? {
              rules: moviesMedium.scan,
              group: groupMoviePaths,
              itemKind: "movie" as const,
            }
          : {
              rules: showsScan,
              group: groupShowPaths,
              itemKind: "show" as const,
            };
      const walked = new Map<string, LibraryDirectory>();
      try {
        for await (const directory of walkLibraryDirectories(
          library.rootPath,
          medium.rules,
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
      const retry = new Map<string, SnapshotUpdate[]>();
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
        for (const [scanPath, entry] of perLibrary) {
          const state = stateById.get(entry.jobId);
          if (state === "completed") {
            for (const update of entry.updates) {
              if (update.modifiedNs === undefined) previous.delete(update.path);
              else previous.set(update.path, update.modifiedNs);
            }
            perLibrary.delete(scanPath);
          } else if (state === "queued" || state === "running") {
            live.add(scanPath);
          } else {
            retry.set(scanPath, entry.updates);
          }
        }
      }
      const existing = await db
        .select({ canonicalFolder: items.canonicalFolder })
        .from(items)
        .where(
          and(eq(items.libraryId, library.id), eq(items.kind, medium.itemKind)),
        );
      const itemFolders = new Set(existing.map((item) => item.canonicalFolder));
      const topLevel = (path: string) =>
        path === "." ? undefined : path.split("/")[0];
      const next = new Map<string, bigint>();
      const scans = new Map<string, Map<string, bigint | undefined>>();
      const addUpdate = (
        scanPath: string,
        snapshotPath: string,
        modifiedNs: bigint | undefined,
      ) => {
        let updates = scans.get(scanPath);
        if (updates === undefined) {
          updates = new Map();
          scans.set(scanPath, updates);
        }
        updates.set(snapshotPath, modifiedNs);
      };
      for (const [path, directory] of walked) {
        if (previous.get(path) === directory.modifiedNs) {
          next.set(path, directory.modifiedNs);
          continue;
        }
        const folders = medium
          .group(directory.files)
          .map((group) => group.canonicalFolder);
        for (const folder of folders) {
          addUpdate(folder, path, directory.modifiedNs);
        }
        const top = topLevel(path);
        let needsScan = folders.length > 0;
        if (medium.itemKind === "movie" && itemFolders.has(path)) {
          addUpdate(path, path, directory.modifiedNs);
          needsScan = true;
        }
        if (
          medium.itemKind === "show" &&
          top !== undefined &&
          itemFolders.has(top)
        ) {
          addUpdate(top, path, directory.modifiedNs);
          needsScan = true;
        }
        if (!needsScan) {
          next.set(path, directory.modifiedNs);
          continue;
        }
        const acknowledged = previous.get(path);
        if (acknowledged !== undefined) next.set(path, acknowledged);
      }
      for (const path of previous.keys()) {
        if (walked.has(path)) continue;
        if (medium.itemKind === "movie") {
          if (itemFolders.has(path)) addUpdate(path, path, undefined);
        } else {
          const top = topLevel(path);
          if (top !== undefined && itemFolders.has(top)) {
            addUpdate(top, path, undefined);
          }
        }
      }
      for (const folder of itemFolders) {
        if (!walked.has(folder)) addUpdate(folder, folder, undefined);
      }
      for (const [scanPath, priorUpdates] of retry) {
        for (const update of priorUpdates) {
          addUpdate(scanPath, update.path, walked.get(update.path)?.modifiedNs);
        }
      }
      for (const scanPath of live) {
        scans.delete(scanPath);
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
        for (const [path, updates] of plan.scans) {
          const job = await queue.enqueue(
            {
              type: "scan",
              libraryId: plan.libraryId,
              path,
              reconcileMissing: true,
            },
            { concurrencyKey: libraryConcurrencyKey(plan.libraryId) },
          );
          recorded.push({
            libraryId: plan.libraryId,
            path,
            entry: {
              jobId: job.id,
              updates: [...updates.entries()].map(
                ([updatePath, modifiedNs]) => ({
                  path: updatePath,
                  modifiedNs,
                }),
              ),
            },
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

  const scheduleElection = () => {
    if (stopped || timer !== undefined || electionTimer !== undefined) return;
    electionTimer = setTimeout(() => {
      electionTimer = undefined;
      electLeader();
    }, intervalMs);
  };

  const electLeader = () => {
    if (stopped || timer !== undefined || electing !== undefined) return;
    electing = (async () => {
      try {
        const connection = await db.$client.reserve();
        try {
          const rows = await connection<{ acquired: boolean }[]>`
            select pg_try_advisory_lock(${repairLockKey}) as acquired`;
          if (rows[0]?.acquired !== true) {
            connection.release();
            scheduleElection();
            return;
          }
          if (stopped || timer !== undefined) {
            await connection`select pg_advisory_unlock(${repairLockKey})`;
            connection.release();
            return;
          }
          leader = connection;
          run().catch(report);
          timer = setInterval(() => {
            run().catch(report);
          }, intervalMs);
        } catch (error) {
          try {
            connection.release();
          } catch {}
          throw error;
        }
      } catch (error) {
        report(error);
        scheduleElection();
      }
    })().finally(() => {
      electing = undefined;
    });
  };

  return {
    run,
    start() {
      if (stopped || timer !== undefined) return;
      electLeader();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (electionTimer !== undefined) {
        clearTimeout(electionTimer);
        electionTimer = undefined;
      }
      await electing?.catch(() => {});
      await active?.catch(() => {});
      const connection = leader;
      leader = undefined;
      if (connection !== undefined) {
        try {
          await connection`select pg_advisory_unlock(${repairLockKey})`;
        } catch (error) {
          report(error);
        } finally {
          try {
            connection.release();
          } catch {}
        }
      }
    },
  };
}
