import { and, eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { itemAncestors, items, libraries } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { groupShowPaths, showsScan } from "../mediums/shows.ts";
import { queueProviderFetch } from "../metadata/jobs.ts";
import {
  reconcileStoredVersions,
  removeOrphanedStoreFolders,
} from "../stored/reconcile.ts";
import { scanDirectory, scanShowDirectory } from "./scan.ts";
import { walkLibrary } from "./walker.ts";

/** The concurrency key that serializes every job for one library. */
export function libraryConcurrencyKey(libraryId: string) {
  return `library:${libraryId}`;
}

/** Registers the built-in library scan job handler. */
export function registerLibraryJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
) {
  registry.register("scan", async (payload, job) => {
    const [library] = await db
      .select()
      .from(libraries)
      .where(eq(libraries.id, payload.libraryId));
    if (!library) throw new AuthError("NOT_FOUND");
    const rules = library.medium === "movies" ? moviesMedium.scan : showsScan;
    if (
      payload.path === "." &&
      payload.changes !== undefined &&
      payload.changes.length > 0
    )
      throw new AuthError("INVALID_INPUT");
    if (payload.path !== ".") {
      if (library.medium === "movies") {
        const result = await scanDirectory(db, library.id, payload.path, {
          changes: payload.changes,
          reconcileMissing: payload.reconcileMissing,
        });
        if (result.itemId !== null) {
          const [item] = await db
            .select({ metadataState: items.metadataState })
            .from(items)
            .where(eq(items.id, result.itemId));
          if (!item) throw new AuthError("NOT_FOUND");
          if (item.metadataState === "pending")
            await queueProviderFetch(db, result.itemId);
        }
      } else {
        const result = await scanShowDirectory(db, library.id, payload.path, {
          changes: payload.changes,
          reconcileMissing: payload.reconcileMissing,
        });
        // One fetch covers the whole Show, so a new pending Episode under a
        // matched Show queues it too.
        if (result.itemId !== null) {
          const [pending] = await db
            .select({ id: items.id })
            .from(items)
            .innerJoin(itemAncestors, eq(itemAncestors.descendantId, items.id))
            .where(
              and(
                eq(itemAncestors.ancestorId, result.itemId),
                eq(items.metadataState, "pending"),
              ),
            )
            .limit(1);
          if (pending !== undefined)
            await queueProviderFetch(db, result.itemId);
        }
      }
      await reconcileStoredVersions(db, library, payload.path);
      await removeOrphanedStoreFolders(db, library, payload.path);
      await publishEvent(db, {
        kind: "library.changed",
        libraryId: library.id,
      });
      return;
    }
    const walked: string[] = [];
    for await (const file of walkLibrary(library.rootPath, rules))
      walked.push(file.path);
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
  });
}
