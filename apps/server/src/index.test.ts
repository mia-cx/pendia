import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "./db/client.ts";
import { migrateDatabase } from "./db/migrate.ts";
import type { JobPayload } from "./db/schema/index.ts";
import { items, libraries } from "./db/schema/index.ts";
import { databaseUrl, withDatabase } from "./db/testing.ts";
import { insertItem } from "./db/tree.ts";
import {
  parseRole,
  type Role,
  requireSupportedBunVersion,
  startPendia,
} from "./index.ts";
import { createJobQueue, type Job, listJobs } from "./jobs/queue.ts";
import { createJobRegistry } from "./jobs/registry.ts";
import { createVideoFixture } from "./mediums/video-common/fixtures.ts";

describe("parseRole", () => {
  const roles: Role[] = ["api", "worker", "transcoder", "watcher", "all"];

  for (const role of roles) {
    test(`accepts ${role}`, () => {
      expect(parseRole(["--role", role])).toBe(role);
    });
  }

  test("rejects an unknown role", () => {
    expect(() => parseRole(["--role", "unknown"])).toThrow(
      'Unknown role "unknown".',
    );
  });
});

describe("requireSupportedBunVersion", () => {
  test("rejects Bun 1.3.11", () => {
    expect(() => requireSupportedBunVersion("1.3.11")).toThrow(
      "Pendia requires Bun 1.4.0 or later.",
    );
  });

  test("accepts Bun 1.4.0", () => {
    expect(() => requireSupportedBunVersion("1.4.0")).not.toThrow();
  });
});

async function waitForJobState(db: Database, id: string, state: Job["state"]) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = (await listJobs(db)).find((row) => row.id === id);
    if (job?.state === state) return job;
    await Bun.sleep(10);
  }
  throw new Error(`Job ${id} did not reach state ${state}.`);
}

describe.skipIf(!databaseUrl)("startPendia job registration", () => {
  test("a supplied scan handler wins while provider-fetch stays built in", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const scans: Extract<JobPayload, { type: "scan" }>[] = [];
      const registry = createJobRegistry();
      registry.register("scan", async (payload) => {
        scans.push(payload);
      });
      const [library] = await db
        .insert(libraries)
        .values({ name: "Movies", medium: "movies", rootPath: "/unused" })
        .returning();
      if (!library) throw new Error("Fixture library missing.");
      const item = await insertItem(db, {
        libraryId: library.id,
        kind: "movie",
        title: "Alien",
        year: 1979,
        canonicalFolder: "Alien (1979)",
        extension: {},
      });
      const server = await startPendia("worker", {
        databaseUrl: url,
        registry,
        workerOptions: {
          concurrency: 1,
          pollIntervalMs: 20,
          queueOptions: { retryDelayMs: 20 },
        },
      });
      try {
        const queue = createJobQueue(db);
        const scanPayload = {
          type: "scan",
          libraryId: Bun.randomUUIDv7(),
          path: ".",
        } as const;
        const scanJob = await queue.enqueue(scanPayload);
        const fetchJob = await queue.enqueue({
          type: "provider-fetch",
          itemId: item.id,
        });
        await waitForJobState(db, scanJob.id, "completed");
        await waitForJobState(db, fetchJob.id, "completed");
        expect(scans).toEqual([scanPayload]);
        const [stored] = await db
          .select()
          .from(items)
          .where(eq(items.id, item.id));
        expect(stored?.metadataState).toBe("unmatched");
      } finally {
        await server.stop();
      }
    }));

  test("a supplied provider-fetch handler wins while scan stays built in", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const root = await mkdtemp(join(tmpdir(), "pendia-library-"));
      try {
        const folder = "Alien (1979) {tmdb-348}";
        await mkdir(join(root, folder));
        await createVideoFixture(join(root, folder, "Alien.mkv"));
        const delivered =
          Promise.withResolvers<
            Extract<JobPayload, { type: "provider-fetch" }>
          >();
        const registry = createJobRegistry();
        registry.register("provider-fetch", async (payload) => {
          delivered.resolve(payload);
        });
        const [library] = await db
          .insert(libraries)
          .values({ name: "Movies", medium: "movies", rootPath: root })
          .returning();
        if (!library) throw new Error("Fixture library missing.");
        const server = await startPendia("worker", {
          databaseUrl: url,
          registry,
          workerOptions: { concurrency: 1, pollIntervalMs: 20 },
        });
        try {
          const queue = createJobQueue(db);
          const scanJob = await queue.enqueue({
            type: "scan",
            libraryId: library.id,
            path: folder,
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const payload = await Promise.race([
            delivered.promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Supplied handler never ran.")),
                2_000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
          const [item] = await db.select().from(items);
          if (!item) throw new Error("Scanned item missing.");
          expect(payload).toEqual({
            type: "provider-fetch",
            itemId: item.id,
          });
          await waitForJobState(db, scanJob.id, "completed");
        } finally {
          await server.stop();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }));
});
