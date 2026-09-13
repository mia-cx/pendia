import { eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { libraries } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { scanDirectory } from "./scan.ts";
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
  registry.register("scan", async (payload) => {
    const [library] = await db
      .select()
      .from(libraries)
      .where(eq(libraries.id, payload.libraryId));
    if (!library) throw new AuthError("NOT_FOUND");
    if (library.medium !== "movies") throw new AuthError("INVALID_INPUT");
    if (payload.path !== ".") {
      const result = await scanDirectory(db, library.id, payload.path);
      if (result.itemId !== null) {
        await createJobQueue(db).enqueue(
          { type: "provider-fetch", itemId: result.itemId },
          { concurrencyKey: `provider:${result.itemId}` },
        );
      }
      await publishEvent(db, {
        kind: "library.changed",
        libraryId: library.id,
      });
      return;
    }
    const paths: string[] = [];
    for await (const file of walkLibrary(library.rootPath, moviesMedium.scan))
      paths.push(file.path);
    const groups = groupMoviePaths(paths);
    if (groups.length === 0) {
      await publishEvent(db, {
        kind: "library.changed",
        libraryId: library.id,
      });
      return;
    }
    const concurrencyKey = libraryConcurrencyKey(library.id);
    await db.transaction(async (tx) => {
      const queue = createJobQueue(tx);
      for (const group of groups)
        await queue.enqueue(
          { type: "scan", libraryId: library.id, path: group.canonicalFolder },
          { concurrencyKey },
        );
    });
  });
}
