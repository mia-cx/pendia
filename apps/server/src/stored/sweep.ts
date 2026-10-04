import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { files, type libraries, versions } from "../db/schema/index.ts";

const storeSuffix = ".pendia";

/** Matches library-relative paths inside a folder; "." is the whole library. */
export function inFolder(path: typeof files.path, folder: string) {
  return folder === "."
    ? undefined
    : sql`starts_with(${path}, ${`${folder}/`})`;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    },
  );

const directories = async (path: string) =>
  (
    await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    })
  ).filter((entry) => entry.isDirectory());

/** Deletes stored output under a library folder that nothing owns: `<file>.pendia` folders whose source is gone from disk and has no File row, and rung folders with no Stored Version. Runs on a worker, which writes to the share. */
export async function sweepStoredFolders(
  db: Database,
  library: typeof libraries.$inferSelect,
  folder = ".",
) {
  // A source whose File row remains keeps its rungs, so a Version still
  // marked complete never loses its folder before the scan drops the File.
  const known = new Set(
    (
      await db
        .select({ path: files.path })
        .from(files)
        .where(
          and(eq(files.libraryId, library.id), inFolder(files.path, folder)),
        )
    ).map((row) => row.path),
  );
  // A store job creates its Version before its folder, so a rung folder
  // without one was dropped by reconciliation.
  const owned = new Set(
    (
      await db
        .select({ storedFolder: versions.storedFolder })
        .from(versions)
        .where(
          and(
            eq(versions.libraryId, library.id),
            eq(versions.origin, "stored"),
          ),
        )
    ).map((row) => row.storedFolder),
  );
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await directories(
      resolve(library.rootPath, relative),
    )) {
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (!entry.name.endsWith(storeSuffix)) {
        await visit(child);
        continue;
      }
      // A bare `.pendia` folder holds Item artwork, not a stored source.
      if (entry.name === storeSuffix) continue;
      const absolute = resolve(library.rootPath, child);
      const source = child.slice(0, -storeSuffix.length);
      if (
        !known.has(source) &&
        !(await exists(resolve(library.rootPath, source)))
      ) {
        await rm(absolute, { recursive: true, force: true });
        continue;
      }
      for (const rung of await directories(absolute)) {
        if (!owned.has(`${child}/${rung.name}`))
          await rm(resolve(absolute, rung.name), {
            recursive: true,
            force: true,
          });
      }
      // The `.pendia` folder goes once its last rung does.
      await rmdir(absolute).catch((error: unknown) => {
        if (errorCode(error) !== "ENOTEMPTY") throw error;
      });
    }
  };
  await visit(folder);
}
