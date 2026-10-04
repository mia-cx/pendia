import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { type libraries, probeCache } from "../db/schema/index.ts";
import { type ProbeResult, probeVideo } from "../mediums/video-common/probe.ts";
import { type LibraryFile, readLibraryFile } from "./walker.ts";

/** A library file with its probe result and whether the persistent cache supplied it. */
export interface ProbedLibraryFile extends LibraryFile {
  probe: ProbeResult;
  cached: boolean;
}

/** Probe a library file, reusing the persistent cache entry when metadata matches. */
export async function probeLibraryFile(
  db: Database,
  library: Pick<typeof libraries.$inferSelect, "id" | "rootPath">,
  path: string,
  probe: typeof probeVideo = probeVideo,
): Promise<ProbedLibraryFile> {
  const normalizedPath = (await readLibraryFile(library.rootPath, path)).path;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${library.id}:${normalizedPath}`}, 0))`,
    );
    const before = await readLibraryFile(library.rootPath, normalizedPath);
    const [cached] = await tx
      .select()
      .from(probeCache)
      .where(
        and(
          eq(probeCache.libraryId, library.id),
          eq(probeCache.path, normalizedPath),
        ),
      );
    if (
      cached &&
      cached.bytes === before.bytes &&
      cached.modifiedNs === before.modifiedNs &&
      cached.result.keyframesSeconds !== undefined
    ) {
      return { ...before, probe: cached.result, cached: true };
    }
    const result = await probe(resolve(library.rootPath, normalizedPath));
    const after = await readLibraryFile(library.rootPath, normalizedPath);
    if (
      after.bytes !== before.bytes ||
      after.modifiedNs !== before.modifiedNs
    ) {
      throw new Error("File changed during probe.");
    }
    await cacheProbe(tx, library.id, after, result);
    return { ...after, probe: result, cached: false };
  });
}

/** Stores a probe result for one file, replacing an older entry at its path. */
export async function cacheProbe(
  db: Pick<Database, "insert">,
  libraryId: string,
  file: Pick<LibraryFile, "path" | "bytes" | "modifiedNs">,
  result: ProbeResult,
) {
  const { bytes, modifiedNs } = file;
  await db
    .insert(probeCache)
    .values({ libraryId, path: file.path, bytes, modifiedNs, result })
    .onConflictDoUpdate({
      target: [probeCache.libraryId, probeCache.path],
      set: { bytes, modifiedNs, result },
    });
}
