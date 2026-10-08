import { posix } from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { files, items, jobs, libraries, versions } from "../db/schema/index.ts";
import { createJobQueue, scanEnqueueLockClass } from "../jobs/queue.ts";
import type { ScanRules } from "../mediums/medium.ts";
import { moviesMedium } from "../mediums/movies.ts";
import { showsScan } from "../mediums/shows.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import { type LibraryRoot, rootedKey, rootsOf } from "./roots.ts";
import { isLibraryScan } from "./scan-payload.ts";
import {
  type LibraryDirectory,
  MissingLibraryPathError,
  readLibraryFile,
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

type ImportedFile = Pick<
  typeof files.$inferSelect,
  "rootId" | "path" | "bytes" | "modifiedAt"
>;

/** A completed sibling covers the current scope only when its imported files still match the disk. */
async function matchesCompletedScan(
  roots: readonly LibraryRoot[],
  walked: ReadonlyMap<string, LibraryDirectory>,
  rules: ScanRules,
  path: string,
  imported: readonly ImportedFile[],
) {
  const present = new Set(
    [...walked].flatMap(([key, directory]) =>
      rules.itemFolder(directory.path) === path
        ? directory.files.map((file) =>
            rootedKey({ rootId: key.slice(0, key.indexOf(":")), path: file }),
          )
        : [],
    ),
  );
  const expected = new Map(
    imported
      .filter((file) => rules.itemFolder(posix.dirname(file.path)) === path)
      .map((file) => [rootedKey(file), file]),
  );
  if (present.size !== expected.size) return false;
  for (const [key, file] of expected) {
    if (!present.has(key)) return false;
    const root = roots.find((candidate) => candidate.id === file.rootId);
    if (!root) return false;
    try {
      const current = await readLibraryFile(root.path, file.path);
      if (
        current.bytes !== file.bytes ||
        current.modifiedAt.getTime() !== file.modifiedAt.getTime()
      )
        return false;
    } catch (error) {
      if (error instanceof MissingLibraryPathError && error.scope === "entry")
        return false;
      throw error;
    }
  }
  return true;
}

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
      roots: LibraryRoot[];
      walked: Map<string, LibraryDirectory>;
      rules: ScanRules;
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
      const roots = await rootsOf(db, library.id);
      try {
        for (const root of roots)
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
      planned.push({
        libraryId: library.id,
        next,
        scans,
        roots,
        walked,
        rules: medium.rules,
      });
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
        if (plan.scans.size === 0) continue;
        await tx.execute(
          sql`select pg_advisory_xact_lock(${scanEnqueueLockClass}, hashtext(${plan.libraryId}))`,
        );
        const libraryScans = and(
          eq(jobs.type, "scan"),
          sql`${jobs.payload}->>'libraryId' = ${plan.libraryId}`,
        );
        const pending = await tx
          .select()
          .from(jobs)
          .where(and(libraryScans, inArray(jobs.state, ["queued", "running"])));
        // A pending root job will discover the folders itself. After fan-out,
        // reuse its children, including siblings completed before the restart.
        if (
          pending.some(
            (job) => job.payload.type === "scan" && isLibraryScan(job.payload),
          )
        )
          continue;
        const runIds = [
          ...new Set(
            pending.flatMap((job) =>
              job.payload.type === "scan" && job.payload.runId !== undefined
                ? [job.payload.runId]
                : [],
            ),
          ),
        ];
        // Reused children keep their original runId. Their requesting root's
        // recorded ids still connect completed siblings to pending work.
        const relatedRuns =
          pending.length === 0
            ? []
            : await tx
                .select({ payload: jobs.payload })
                .from(jobs)
                .where(
                  and(
                    libraryScans,
                    sql`exists (select 1 from jsonb_array_elements_text(${jobs.payload}->'childJobIds') as child(id) where ${inArray(
                      sql`child.id`,
                      pending.map((job) => job.id),
                    )})`,
                  ),
                );
        const childJobIds = relatedRuns.flatMap(({ payload }) =>
          payload.type === "scan" ? (payload.childJobIds ?? []) : [],
        );
        const completed =
          runIds.length === 0 && childJobIds.length === 0
            ? []
            : await tx
                .select()
                .from(jobs)
                .where(
                  and(
                    libraryScans,
                    eq(jobs.state, "completed"),
                    or(
                      runIds.length === 0
                        ? undefined
                        : inArray(sql`${jobs.payload}->>'runId'`, runIds),
                      childJobIds.length === 0
                        ? undefined
                        : inArray(jobs.id, childJobIds),
                    ),
                  ),
                );
        const coverage = new Map(
          [...completed, ...pending].flatMap((job) =>
            job.payload.type === "scan"
              ? [[job.payload.path, job] as const]
              : [],
          ),
        );
        const imported =
          completed.length === 0
            ? []
            : await tx
                .select({
                  rootId: files.rootId,
                  path: files.path,
                  bytes: files.bytes,
                  modifiedAt: files.modifiedAt,
                })
                .from(files)
                .innerJoin(versions, eq(versions.id, files.versionId))
                .where(
                  and(
                    eq(files.libraryId, plan.libraryId),
                    eq(versions.origin, "imported"),
                  ),
                );
        for (const [path, updates] of plan.scans) {
          let covered = coverage.get(path);
          if (
            covered?.state === "completed" &&
            !(await matchesCompletedScan(
              plan.roots,
              plan.walked,
              plan.rules,
              path,
              imported,
            ))
          )
            covered = undefined;
          const job =
            covered?.state === "completed"
              ? covered
              : await queue.enqueueScanChanges(
                  {
                    type: "scan",
                    libraryId: plan.libraryId,
                    path,
                    reconcileMissing: true,
                    // Repair names an Item folder; `.` can hold loose media.
                    ...(path === "." ? { changes: [] } : {}),
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
          if (covered === undefined) enqueued += 1;
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
