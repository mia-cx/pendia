import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { files, libraries, versions } from "../db/schema/index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";

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

/** Scans a 12 s 720p movie with 3 s keyframes into a library with the given stored-version policy. */
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
