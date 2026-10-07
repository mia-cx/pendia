import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { probeCache } from "../db/schema/index.ts";
import {
  type ProbeResult,
  probeVideo,
  UnreadableMediaError,
} from "../mediums/video-common/probe.ts";
import { type LibraryRoot, locateIn } from "./roots.ts";
import { type LibraryFile, readLibraryFile } from "./walker.ts";

/** A library file with its probe result and whether the persistent cache supplied it. */
export interface ProbedLibraryFile extends LibraryFile {
  probe: ProbeResult;
  cached: boolean;
}

/** Probe a file of one root, reusing the persistent cache entry when metadata matches. */
export async function probeLibraryFile(
  db: Database,
  root: LibraryRoot,
  path: string,
  probe: typeof probeVideo = probeVideo,
): Promise<ProbedLibraryFile> {
  const normalizedPath = (await readLibraryFile(root.path, path)).path;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${root.id}:${normalizedPath}`}, 0))`,
    );
    const before = await locateIn(root.path, normalizedPath);
    const [cached] = await tx
      .select()
      .from(probeCache)
      .where(
        and(
          eq(probeCache.rootId, root.id),
          eq(probeCache.path, normalizedPath),
        ),
      );
    if (
      cached &&
      cached.bytes === before.bytes &&
      cached.modifiedNs === before.modifiedNs
    ) {
      return { ...before, probe: cached.result, cached: true };
    }
    const result = await probe(before.absolute).catch(
      async (error: unknown) => {
        if (!(error instanceof UnreadableMediaError)) throw error;
        // A failed probe can also mean the file disappeared or changed mid-read.
        const after = await readLibraryFile(root.path, normalizedPath);
        if (
          after.bytes !== before.bytes ||
          after.modifiedNs !== before.modifiedNs
        )
          throw new Error("File changed during probe.");
        throw error;
      },
    );
    const after = await readLibraryFile(root.path, normalizedPath);
    if (
      after.bytes !== before.bytes ||
      after.modifiedNs !== before.modifiedNs
    ) {
      throw new Error("File changed during probe.");
    }
    await cacheProbe(tx, root.id, after, result);
    return { ...after, probe: result, cached: false };
  });
}

/** Stores a probe result for one file, replacing an older entry at its path. */
export async function cacheProbe(
  db: Pick<Database, "insert">,
  rootId: string,
  file: Pick<LibraryFile, "path" | "bytes" | "modifiedNs">,
  result: ProbeResult,
) {
  const { bytes, modifiedNs } = file;
  await db
    .insert(probeCache)
    .values({ rootId, path: file.path, bytes, modifiedNs, result })
    .onConflictDoUpdate({
      target: [probeCache.rootId, probeCache.path],
      set: { bytes, modifiedNs, result },
    });
}
