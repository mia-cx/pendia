import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { files, libraries, versions } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { registerLibraryJobs } from "../libraries/jobs.ts";
import { scanDirectory } from "../libraries/scan.ts";
import {
  createVideoFixture,
  type VideoFixtureOptions,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { registerStoreJobs } from "./jobs.ts";

/** The folder and file of the scanned fixture movie. */
export const fixtureFolder = "Movie (2020)";
export const fixturePath = `${fixtureFolder}/Movie (2020).mkv`;

/** A policy with the source remux and a 360p encode. */
export const twoRungPolicy: JsonObject = {
  rungs: [
    { name: "source" },
    { name: "360p", height: 360, bitrate: 1_000_000 },
  ],
};

/** Scans a 12 s 720p movie with 3 s keyframes, one SRT track unless the options say otherwise, into a library with the given stored-version policy. */
export async function withStoredLibrary(
  db: Database,
  storedVersions: JsonObject | null,
  run: (fixture: {
    root: string;
    library: typeof libraries.$inferSelect;
    itemId: string;
    file: typeof files.$inferSelect;
    version: typeof versions.$inferSelect;
  }) => Promise<void>,
  options: VideoFixtureOptions = {},
) {
  await withVideoFixture(async (root) => {
    await mkdir(join(root, fixtureFolder), { recursive: true });
    await createVideoFixture(join(root, fixturePath), {
      width: 1280,
      height: 720,
      durationSeconds: 12,
      frameRate: 25,
      gopSeconds: 3,
      pattern: "testsrc2",
      ...options,
    });
    const [library] = await db
      .insert(libraries)
      .values({
        name: "Movies",
        medium: "movies",
        rootPath: root,
        configuration: storedVersions === null ? {} : { storedVersions },
      })
      .returning();
    if (library === undefined) throw new Error("Fixture library missing.");
    const { itemId } = await scanDirectory(db, library.id, fixtureFolder);
    if (itemId === null) throw new Error("Fixture scan found no Item.");
    const [row] = await db
      .select({ file: files, version: versions })
      .from(files)
      .innerJoin(versions, eq(versions.id, files.versionId))
      .where(eq(files.itemId, itemId));
    if (row === undefined || !row.version.timelineAligned)
      throw new Error("Fixture scan left no aligned Version.");
    await run({ root, library, itemId, ...row });
  });
}

/** Runs every ready scan and store job, the way a worker inside the idle window would. */
export async function drain(db: Database) {
  const registry = createJobRegistry();
  registerLibraryJobs(db, registry);
  registerStoreJobs(db, registry, { now: () => new Date(2026, 9, 4, 2, 0) });
  const queue = createJobQueue(db);
  for (;;) {
    const job = await queue.claim(["scan", "store"]);
    if (job === undefined) return;
    await registry.run(job);
    await queue.complete(job);
  }
}

/** Queues a reconciling scan of the fixture folder. */
export const scanFolder = (db: Database, libraryId: string) =>
  createJobQueue(db).enqueue({
    type: "scan",
    libraryId,
    path: fixtureFolder,
    reconcileMissing: true,
  });
