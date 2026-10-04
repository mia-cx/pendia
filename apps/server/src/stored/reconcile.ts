import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  files,
  jobs,
  type libraries,
  streams,
  versions,
} from "../db/schema/index.ts";
import { enqueueStore, storedFolderOf } from "./jobs.ts";
import { policyMatches, readStoredVersionPolicy, rungFits } from "./policy.ts";

type Library = typeof libraries.$inferSelect;

const storeSuffix = ".pendia";

/** Matches library-relative paths inside a folder; "." is the whole library. */
function inFolder(path: typeof files.path, folder: string) {
  return folder === "."
    ? undefined
    : sql`starts_with(${path}, ${`${folder}/`})`;
}

/** The aligned single-file source of each Item that stored rungs derive from: the tallest, then the highest bitrate. */
export async function bestSources(db: Database, where: SQL | undefined) {
  const rows = await db
    .select({
      itemId: files.itemId,
      versionId: files.versionId,
      fileId: files.id,
      codec: streams.codec,
      height: streams.height,
      hdr: streams.hdr,
      bitrate: streams.bitrate,
      disposition: streams.disposition,
    })
    .from(files)
    .innerJoin(versions, eq(versions.id, files.versionId))
    .innerJoin(
      streams,
      and(eq(streams.fileId, files.id), eq(streams.kind, "video")),
    )
    .where(and(eq(versions.timelineAligned, true), where));
  const filesPerVersion = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = filesPerVersion.get(row.versionId) ?? new Set();
    set.add(row.fileId);
    filesPerVersion.set(row.versionId, set);
  }
  const best = new Map<
    string,
    {
      fileId: string;
      bitrate: bigint;
      video: { codec: string; height: number; hdr: string };
    }
  >();
  for (const row of rows) {
    if (row.disposition.attached_pic === true) continue;
    if (row.height === null || row.hdr === null) continue;
    if (filesPerVersion.get(row.versionId)?.size !== 1) continue;
    const bitrate = row.bitrate ?? 0n;
    const current = best.get(row.itemId);
    if (
      current !== undefined &&
      (row.height < current.video.height ||
        (row.height === current.video.height && bitrate <= current.bitrate))
    )
      continue;
    best.set(row.itemId, {
      fileId: row.fileId,
      bitrate,
      video: { codec: row.codec, height: row.height, hdr: row.hdr },
    });
  }
  return best;
}

/** Enqueues a store job for a rung unless it is complete or already queued or running; true when it enqueued. */
export async function requestStore(
  db: Database,
  sourceFileId: string,
  rung: string,
) {
  const [complete] = await db
    .select({ id: versions.id })
    .from(versions)
    .where(
      and(
        eq(versions.sourceFileId, sourceFileId),
        eq(versions.rung, rung),
        eq(versions.complete, true),
      ),
    )
    .limit(1);
  if (complete !== undefined) return false;
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "store"),
        inArray(jobs.state, ["queued", "running"]),
        sql`${jobs.payload}->>'sourceFileId' = ${sourceFileId}`,
        sql`${jobs.payload}->>'rung' = ${rung}`,
      ),
    )
    .limit(1);
  if (pending !== undefined) return false;
  await enqueueStore(db, { sourceFileId, rung });
  return true;
}

/** Brings the stored rungs of a library folder in line with its policy: drops rungs it no longer names or whose source moved, and enqueues missing wanted ones. */
export async function reconcileStoredVersions(
  db: Database,
  library: Library,
  folder = ".",
) {
  const policy = readStoredVersionPolicy(library.configuration);
  const named = new Set(policy?.rungs.map((rung) => rung.name));
  const stored = await db
    .select({
      id: versions.id,
      rung: versions.rung,
      storedFolder: versions.storedFolder,
      sourcePath: files.path,
    })
    .from(versions)
    .innerJoin(files, eq(files.id, versions.sourceFileId))
    .where(
      and(
        eq(versions.libraryId, library.id),
        eq(versions.origin, "stored"),
        inFolder(files.path, folder),
      ),
    );
  for (const row of stored) {
    if (row.rung === null || row.storedFolder === null) continue;
    if (
      named.has(row.rung) &&
      row.storedFolder === storedFolderOf(row.sourcePath, row.rung)
    )
      continue;
    await db.delete(versions).where(eq(versions.id, row.id));
    const absolute = resolve(library.rootPath, row.storedFolder);
    await rm(absolute, { recursive: true, force: true });
    // The `.pendia` folder goes once its last rung does.
    await rmdir(dirname(absolute)).catch(() => {});
  }
  if (policy === null) return;
  const sources = await bestSources(
    db,
    and(eq(files.libraryId, library.id), inFolder(files.path, folder)),
  );
  for (const source of sources.values()) {
    if (!policyMatches(policy.when, source.video)) continue;
    for (const rung of policy.rungs) {
      if (rungFits(rung, source.video))
        await requestStore(db, source.fileId, rung.name);
    }
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  );

/** Deletes every `<file>.pendia` folder under a library folder whose source file is gone from disk. */
export async function removeOrphanedStoreFolders(
  library: Library,
  folder = ".",
) {
  const visit = async (relative: string): Promise<void> => {
    const absolute = resolve(library.rootPath, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (!entry.name.endsWith(storeSuffix)) {
        await visit(child);
        continue;
      }
      // A bare `.pendia` folder holds Item artwork, not a stored source.
      if (entry.name === storeSuffix) continue;
      const source = resolve(
        library.rootPath,
        child.slice(0, -storeSuffix.length),
      );
      if (!(await exists(source)))
        await rm(resolve(library.rootPath, child), {
          recursive: true,
          force: true,
        });
    }
  };
  await visit(folder);
}
