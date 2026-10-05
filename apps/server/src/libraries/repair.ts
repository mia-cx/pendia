import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { items, jobs, libraries } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { moviesMedium } from "../mediums/movies.ts";
import { showsScan } from "../mediums/shows.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import { rootedKey, rootsOf } from "./roots.ts";
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
              itemKind: "movie" as const,
            }
          : {
              rules: showsScan,
              itemKind: "show" as const,
            };
      // Snapshots key each directory by its root; scans name root-relative folders.
      const walked = new Map<string, LibraryDirectory>();
      try {
        for (const root of await rootsOf(db, library.id))
          for await (const directory of walkLibraryDirectories(
            root.path,
            medium.rules,
          ))
            walked.set(
              rootedKey({ rootId: root.id, path: directory.path }),
              directory,
            );
      } catch (error) {
        // A missing root may be an unmounted share, so the Library waits.
        if (
          error instanceof MissingLibraryPathError &&
          error.scope === "root"
        ) {
          continue;
        }
        throw error;
      }
      const walkedPaths = new Set(
        [...walked.values()].map((directory) => directory.path),
      );
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
      for (const [key, directory] of walked) {
        const { path } = directory;
        if (previous.get(key) === directory.modifiedNs) {
          next.set(key, directory.modifiedNs);
          continue;
        }
        // A changed directory scans its Item folder when it holds media or an Item.
        const scanFolder = medium.rules.itemFolder(path);
        const needsScan =
          directory.files.length > 0 || itemFolders.has(scanFolder);
        if (needsScan) addUpdate(scanFolder, key, directory.modifiedNs);
        else {
          next.set(key, directory.modifiedNs);
          continue;
        }
        const acknowledged = previous.get(key);
        if (acknowledged !== undefined) next.set(key, acknowledged);
      }
      for (const key of previous.keys()) {
        if (walked.has(key)) continue;
        // Root ids hold no colon, so the path follows the first one.
        const path = key.slice(key.indexOf(":") + 1);
        const scanFolder = medium.rules.itemFolder(path);
        if (itemFolders.has(scanFolder)) addUpdate(scanFolder, key, undefined);
      }
      for (const folder of itemFolders) {
        if (!walkedPaths.has(folder)) addUpdate(folder, folder, undefined);
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
