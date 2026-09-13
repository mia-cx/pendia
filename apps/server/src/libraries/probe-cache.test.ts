import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { libraries, probeCache } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import { probeLibraryFile } from "./probe-cache.ts";

const relative = "Alien (1979)/Alien.mkv";

async function withLibrary(
  db: Database,
  rootPath: string,
  run: (library: { id: string; rootPath: string }) => Promise<void>,
) {
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  await run(library);
}

async function withMovie(run: (dir: string) => Promise<void>): Promise<void> {
  await withVideoFixture(async (dir) => {
    const file = join(dir, relative);
    await mkdir(dirname(file), { recursive: true });
    await createVideoFixture(file);
    await writeFile(join(dir, "notes.txt"), "notes");
    await run(dir);
  });
}

describe.skipIf(!databaseUrl)("probeLibraryFile", () => {
  test("probes once and serves a second connection from cache", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withMovie(async (dir) => {
        await withLibrary(db, dir, async (library) => {
          const seen: string[] = [];
          const probe = async (path: string) => {
            seen.push(path);
            return probeVideo(path);
          };
          const first = await probeLibraryFile(db, library, relative, probe);
          expect(first.cached).toBe(false);
          expect(first.probe.streams).toHaveLength(3);
          expect(seen).toHaveLength(1);

          const second = createDatabase(url);
          try {
            const hit = await probeLibraryFile(
              second.db,
              library,
              relative,
              probe,
            );
            expect(hit.cached).toBe(true);
            expect(hit.probe).toEqual(first.probe);
            expect(hit.bytes).toBe(first.bytes);
            expect(seen).toHaveLength(1);
          } finally {
            await second.close();
          }
        });
      });
    }));

  test("re-probes when the file mtime changes", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withMovie(async (dir) => {
        await withLibrary(db, dir, async (library) => {
          const seen: string[] = [];
          const probe = async (path: string) => {
            seen.push(path);
            return probeVideo(path);
          };
          const before = await probeLibraryFile(db, library, relative, probe);
          const changed = new Date("2026-01-02T00:00:00Z");
          await utimes(join(dir, relative), changed, changed);
          const result = await probeLibraryFile(db, library, relative, probe);
          expect(result.cached).toBe(false);
          expect(seen).toHaveLength(2);
          expect(result.bytes).toBe(before.bytes);
          expect(result.modifiedNs).not.toBe(before.modifiedNs);
        });
      });
    }));

  test("re-probes when bytes change even with a restored mtime", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withMovie(async (dir) => {
        await withLibrary(db, dir, async (library) => {
          const seen: string[] = [];
          const probe = async (path: string) => {
            seen.push(path);
            return probeVideo(path);
          };
          const file = join(dir, relative);
          const stamped = new Date("2026-01-02T00:00:00Z");
          await utimes(file, stamped, stamped);
          const before = await probeLibraryFile(db, library, relative, probe);
          await appendFile(file, "extra bytes");
          await utimes(file, stamped, stamped);
          const result = await probeLibraryFile(db, library, relative, probe);
          expect(result.cached).toBe(false);
          expect(seen).toHaveLength(2);
          expect(result.bytes).toBe(
            before.bytes + BigInt("extra bytes".length),
          );
          expect(result.modifiedNs).toBe(before.modifiedNs);
        });
      });
    }));

  test("saves nothing when the probe fails", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withMovie(async (dir) => {
        await withLibrary(db, dir, async (library) => {
          const failing = () => Promise.reject(new Error("probe broke"));
          await expect(
            probeLibraryFile(db, library, relative, failing),
          ).rejects.toThrow("probe broke");
          expect(await db.select().from(probeCache)).toHaveLength(0);
          const result = await probeLibraryFile(db, library, relative);
          expect(result.cached).toBe(false);
        });
      });
    }));

  test("rejects when the file changes during the probe, then re-probes", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await withMovie(async (dir) => {
        await withLibrary(db, dir, async (library) => {
          const mutating = async (path: string) => {
            const result = await probeVideo(path);
            await appendFile(path, "mutated");
            return result;
          };
          await expect(
            probeLibraryFile(db, library, relative, mutating),
          ).rejects.toThrow("File changed during probe.");
          expect(await db.select().from(probeCache)).toHaveLength(0);
          const seen: string[] = [];
          const result = await probeLibraryFile(
            db,
            library,
            relative,
            async (path) => {
              seen.push(path);
              return probeVideo(path);
            },
          );
          expect(result.cached).toBe(false);
          expect(seen).toHaveLength(1);
        });
      });
    }));

  test("two simultaneous connections share one probe", () =>
    withDatabase(async (_db, url) => {
      const db = createDatabase(url);
      try {
        await migrateDatabase(db.db);
        await withMovie(async (dir) => {
          await withLibrary(db.db, dir, async (library) => {
            const first = createDatabase(url);
            const second = createDatabase(url);
            const seen: string[] = [];
            const probe = async (path: string) => {
              seen.push(path);
              return probeVideo(path);
            };
            try {
              const results = await Promise.all([
                probeLibraryFile(first.db, library, relative, probe),
                probeLibraryFile(second.db, library, relative, probe),
              ]);
              expect(seen).toHaveLength(1);
              expect(results.map((result) => result.cached).sort()).toEqual([
                false,
                true,
              ]);
            } finally {
              await first.close();
              await second.close();
            }
          });
        });
      } finally {
        await db.close();
      }
    }));
});
