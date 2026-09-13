import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { items, libraries } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import { MissingLibraryPathError, walkLibraryDirectories } from "./walker.ts";

/** Options for the scheduled directory-mtime repair pass. */
export type RepairOptions = {
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

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
      paths: string[];
    }[] = [];
    for (const library of rows) {
      const previous = snapshots.get(library.id) ?? new Map<string, bigint>();
      const next = new Map<string, bigint>();
      const paths = new Set<string>();
      try {
        for await (const directory of walkLibraryDirectories(
          library.rootPath,
          moviesMedium.scan,
        )) {
          next.set(directory.path, directory.modifiedNs);
          if (previous.get(directory.path) === directory.modifiedNs) {
            continue;
          }
          for (const group of groupMoviePaths(directory.files)) {
            paths.add(group.canonicalFolder);
          }
        }
      } catch (error) {
        if (error instanceof MissingLibraryPathError) continue;
        throw error;
      }
      const existing = await db
        .select({ canonicalFolder: items.canonicalFolder })
        .from(items)
        .where(and(eq(items.libraryId, library.id), eq(items.kind, "movie")));
      for (const item of existing) {
        const current = next.get(item.canonicalFolder);
        if (
          current === undefined ||
          previous.get(item.canonicalFolder) !== current
        ) {
          paths.add(item.canonicalFolder);
        }
      }
      planned.push({ libraryId: library.id, next, paths: [...paths] });
    }
    let enqueued = 0;
    await db.transaction(async (tx) => {
      const queue = createJobQueue(tx);
      for (const plan of planned) {
        for (const path of plan.paths) {
          await queue.enqueue(
            { type: "scan", libraryId: plan.libraryId, path },
            { concurrencyKey: libraryConcurrencyKey(plan.libraryId) },
          );
          enqueued += 1;
        }
      }
    });
    for (const plan of planned) snapshots.set(plan.libraryId, plan.next);
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
