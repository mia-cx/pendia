import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { jobs, settings, streams, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { readStoreManifest } from "./encode.ts";
import {
  enqueueStore,
  enqueueStoreSweep,
  registerStoreJobs,
  type StoreJobOptions,
} from "./jobs.ts";
import { twoRungPolicy, withStoredLibrary } from "./testing.ts";

const local = (day: number, hours: number, minutes = 0, seconds = 0) =>
  new Date(2026, 9, day, hours, minutes, seconds);
const inside = () => local(4, 2);

/** Claims the next store job, runs it through a fresh registry and completes it. */
async function runNextStore(db: Database, options: StoreJobOptions) {
  const registry = createJobRegistry();
  registerStoreJobs(db, registry, options);
  const queue = createJobQueue(db);
  const job = await queue.claim(["store"]);
  if (job === undefined) throw new Error("No store job is ready.");
  await registry.run(job);
  await queue.complete(job);
  return job;
}

const storedRows = (db: Database) =>
  db.select().from(versions).where(eq(versions.origin, "stored"));

const queuedStores = (db: Database) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "store"), eq(jobs.state, "queued")));

describe.skipIf(!databaseUrl)("store job", () => {
  test(
    "stores a complete rung with fileless Streams at low priority",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await withStoredLibrary(
          db,
          twoRungPolicy,
          async ({ root, file, version }) => {
            const job = await enqueueStore(db, {
              sourceFileId: file.id,
              rung: "360p",
            });
            expect(job).toMatchObject({
              priority: -10,
              concurrencyKey: "store",
            });
            await runNextStore(db, { now: inside });

            const [stored] = await storedRows(db);
            expect(stored).toMatchObject({
              itemId: version.itemId,
              origin: "stored",
              sourceFileId: file.id,
              storedFolder: `${file.path}.thalia/360p`,
              rung: "360p",
              complete: true,
              segmentTimelineId: version.segmentTimelineId,
              timelineAligned: true,
              durationSeconds: version.durationSeconds,
            });
            expect(stored?.bytes).toBeGreaterThan(0n);
            const rows = await db
              .select()
              .from(streams)
              .where(eq(streams.versionId, stored?.id ?? ""));
            expect(rows.find((row) => row.kind === "video")).toMatchObject({
              fileId: null,
              codec: "h264",
              profile: "high",
              width: 640,
              height: 360,
              bitrate: 1_000_000n,
              hdr: "sdr",
            });
            expect(rows.find((row) => row.kind === "audio")).toMatchObject({
              fileId: null,
              codec: "aac",
              channels: 2,
              bitrate: 160_000n,
            });
            expect(
              await readStoreManifest(join(root, stored?.storedFolder ?? "")),
            ).toMatchObject({ rung: "360p", complete: true });
          },
        );
      }),
    120_000,
  );

  test(
    "waits for the next idle window when claimed outside it",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await withStoredLibrary(db, twoRungPolicy, async ({ file }) => {
          await enqueueStore(db, { sourceFileId: file.id, rung: "source" });
          await runNextStore(db, { now: () => local(4, 12) });
          expect(await storedRows(db)).toEqual([]);
          expect(await queuedStores(db)).toMatchObject([
            {
              payload: { type: "store", sourceFileId: file.id, rung: "source" },
              priority: -10,
              concurrencyKey: "store",
              runAfter: local(5, 1),
            },
          ]);
        });
      }),
    60_000,
  );

  test(
    "stops ffmpeg at the window end and finishes in the next window",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await withStoredLibrary(db, twoRungPolicy, async ({ root, file }) => {
          await enqueueStore(db, { sourceFileId: file.id, rung: "360p" });
          // The clock starts 1.5 s before the default window closes at 07:00.
          const started = Date.now();
          const nearEnd = () =>
            new Date(
              local(4, 6, 59, 58).getTime() + 500 + Date.now() - started,
            );
          await runNextStore(db, {
            now: nearEnd,
            readRate: { rate: 1, initialBurstSeconds: 0 },
          });
          expect(Date.now() - started).toBeLessThan(10_000);
          const [stopped] = await storedRows(db);
          expect(stopped?.complete).toBe(false);
          const folder = join(root, stopped?.storedFolder ?? "");
          expect(await readStoreManifest(folder)).toBeNull();
          expect(await queuedStores(db)).toMatchObject([
            { payload: { rung: "360p" }, runAfter: local(5, 1) },
          ]);

          await db
            .update(jobs)
            .set({ runAfter: new Date() })
            .where(eq(jobs.state, "queued"));
          await runNextStore(db, { now: inside });
          const [finished] = await storedRows(db);
          expect(finished).toMatchObject({ id: stopped?.id, complete: true });
          expect(await readStoreManifest(folder)).toMatchObject({
            complete: true,
          });
        });
      }),
    120_000,
  );

  test(
    "a stopped encode books its continuation in the window as it is now",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await withStoredLibrary(db, twoRungPolicy, async ({ file }) => {
          await enqueueStore(db, { sourceFileId: file.id, rung: "360p" });
          const started = Date.now();
          const nearEnd = () =>
            new Date(
              local(4, 6, 59, 58).getTime() + 500 + Date.now() - started,
            );
          const run = runNextStore(db, {
            now: nearEnd,
            readRate: { rate: 1, initialBurstSeconds: 0 },
          });
          // An admin stretches the window to noon while the encode runs.
          await Bun.sleep(300);
          await db.insert(settings).values({
            key: "store",
            value: { idleWindow: { start: "01:00", end: "12:00" } },
          });
          await run;
          // Bounded by this run's own wall-clock span, so the old window's
          // next 01:00 fails here whatever today's date is.
          const [continuation] = await queuedStores(db);
          const runAfter = continuation?.runAfter.getTime() ?? 0;
          expect(runAfter).toBeGreaterThanOrEqual(started - 1_000);
          expect(runAfter).toBeLessThanOrEqual(Date.now());
        });
      }),
    120_000,
  );

  test(
    "drops a job whose rung the policy no longer names",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await withStoredLibrary(db, twoRungPolicy, async ({ file }) => {
          await enqueueStore(db, { sourceFileId: file.id, rung: "1080p" });
          await runNextStore(db, { now: inside });
          expect(await storedRows(db)).toEqual([]);
          expect(await queuedStores(db)).toEqual([]);
        });
      }),
    60_000,
  );
});

describe.skipIf(!databaseUrl)("store sweeps", () => {
  test(
    "a sweep and an encode never run at the same time",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        await withStoredLibrary(
          db,
          twoRungPolicy,
          async ({ library, file }) => {
            await enqueueStoreSweep(db, library.id, ".");
            await enqueueStore(db, { sourceFileId: file.id, rung: "source" });
            const queue = createJobQueue(db);
            // Whichever claims first holds the `store` key until it finishes, so
            // a sweep's ownership snapshot can never miss a Version made mid-sweep.
            const first = await queue.claim(["store"]);
            expect(first).toBeDefined();
            expect(await queue.claim(["store"])).toBeUndefined();
            if (first !== undefined) await queue.complete(first);
            expect(await queue.claim(["store"])).toBeDefined();
          },
        );
      }),
    60_000,
  );
});
