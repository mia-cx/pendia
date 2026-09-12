import { describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import type { JobPayload } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, listJobs } from "./queue.ts";

function probePayload(): JobPayload {
  return { type: "probe", fileId: Bun.randomUUIDv7() };
}

async function databaseNow(db: Database) {
  const [row] = await db.$client<{ now: Date }[]>`select now() as now`;
  if (!row) throw new Error("Database clock query returned no row.");
  return row.now;
}

async function claimWhenReady(queue: ReturnType<typeof createJobQueue>) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = await queue.claim();
    if (job) return job;
    await Bun.sleep(10);
  }
  throw new Error("No claimable job before the deadline.");
}

test("rejects non-positive or non-finite retry delays", () => {
  const db = {} as Database;
  for (const retryDelayMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => createJobQueue(db, { retryDelayMs })).toThrow(
      "Retry delay must be positive and finite.",
    );
});

describe.skipIf(!databaseUrl)("Job queue", () => {
  test("enqueues typed payloads and lists them with filters and paging", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const payload = probePayload();
      const job = await queue.enqueue(payload);
      const listed = await listJobs(db);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: job.id,
        type: "probe",
        payload,
        state: "queued",
        attempts: 0,
        maxAttempts: 3,
        priority: 0,
      });

      const scan: JobPayload = {
        type: "scan",
        libraryId: Bun.randomUUIDv7(),
        path: "/shows",
      };
      const runAfter = new Date((await databaseNow(db)).getTime() + 60_000);
      const scheduled = await queue.enqueue(scan, {
        priority: 9,
        maxAttempts: 2,
        runAfter,
        concurrencyKey: "library",
      });
      expect(scheduled).toMatchObject({
        type: "scan",
        payload: scan,
        priority: 9,
        maxAttempts: 2,
        concurrencyKey: "library",
        state: "queued",
      });

      expect(await listJobs(db, { type: "probe" })).toMatchObject([
        { id: job.id },
      ]);
      expect(await listJobs(db, { type: "scan" })).toMatchObject([
        { id: scheduled.id },
      ]);
      expect(await listJobs(db, { state: "running" })).toHaveLength(0);
      expect(
        (await listJobs(db, { state: "queued" })).map((row) => row.id),
      ).toEqual([scheduled.id, job.id]);
      expect((await listJobs(db, { limit: 1 })).map((row) => row.id)).toEqual([
        scheduled.id,
      ]);
      expect(
        (await listJobs(db, { limit: 1, offset: 1 })).map((row) => row.id),
      ).toEqual([job.id]);
    }));

  test("two independent queues never claim the same job", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const second = createDatabase(url);
      try {
        const secondQueue = createJobQueue(second.db);
        const enqueued = await Promise.all(
          Array.from({ length: 16 }, () => queue.enqueue(probePayload())),
        );
        const enqueuedIds = new Set(enqueued.map((job) => job.id));
        const claimed = await Promise.all(
          Array.from({ length: 24 }, (_, index) =>
            (index % 2 === 0 ? queue : secondQueue).claim(),
          ),
        );
        const claimedJobs = claimed.filter((job) => job !== undefined);
        expect(claimedJobs).toHaveLength(16);
        const claimedIds = new Set(claimedJobs.map((job) => job.id));
        expect(claimedIds.size).toBe(16);
        expect(claimedIds).toEqual(enqueuedIds);
        const running = await listJobs(db, { state: "running" });
        expect(running).toHaveLength(16);
        expect(running.every((job) => job.attempts === 1)).toBe(true);
      } finally {
        await second.close();
      }
    }));

  test("delays claims until runAfter", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const delayed = await queue.enqueue(probePayload(), {
        runAfter: new Date((await databaseNow(db)).getTime() + 150),
      });
      expect(await queue.claim()).toBeUndefined();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const claimed = await queue.claim();
        if (claimed) {
          expect(claimed.id).toBe(delayed.id);
          return;
        }
        await Bun.sleep(25);
      }
      throw new Error("Delayed job was never claimed.");
    }));

  test("orders claims by priority then runAfter and skips future jobs", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const now = await databaseNow(db);
      const future = await queue.enqueue(probePayload(), {
        priority: 100,
        runAfter: new Date(now.getTime() + 60_000),
      });
      const low = await queue.enqueue(probePayload(), {
        priority: 1,
        runAfter: new Date(now.getTime() - 1_000),
      });
      const olderHigh = await queue.enqueue(probePayload(), {
        priority: 10,
        runAfter: new Date(now.getTime() - 3_000),
      });
      const newerHigh = await queue.enqueue(probePayload(), {
        priority: 10,
        runAfter: new Date(now.getTime() - 2_000),
      });
      const first = await queue.claim();
      const second = await queue.claim();
      const third = await queue.claim();
      expect([first?.id, second?.id, third?.id]).toEqual([
        olderHigh.id,
        newerHigh.id,
        low.id,
      ]);
      expect(await queue.claim()).toBeUndefined();
      expect(
        (await listJobs(db, { state: "queued" })).map((job) => job.id),
      ).toEqual([future.id]);
    }));

  test("retries failures with exponential backoff and fails at max attempts", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db, { retryDelayMs: 200 });
      const job = await queue.enqueue(probePayload());
      const first = await queue.claim();
      if (!first) throw new Error("First claim missing.");
      expect(first.attempts).toBe(1);
      const beforeFirst = await databaseNow(db);
      const retried = await queue.fail(first, "first error");
      const afterFirst = await databaseNow(db);
      expect(retried).toMatchObject({
        id: job.id,
        state: "queued",
        attempts: 1,
        error: "first error",
      });
      expect(retried?.runAfter.getTime()).toBeGreaterThanOrEqual(
        beforeFirst.getTime() + 200 - 1,
      );
      expect(retried?.runAfter.getTime()).toBeLessThanOrEqual(
        afterFirst.getTime() + 200 + 1,
      );
      expect(await queue.claim()).toBeUndefined();

      const second = await claimWhenReady(queue);
      expect(second.attempts).toBe(2);
      const beforeSecond = await databaseNow(db);
      const retriedSecond = await queue.fail(second, new Error("second error"));
      const afterSecond = await databaseNow(db);
      expect(retriedSecond).toMatchObject({
        id: job.id,
        state: "queued",
        attempts: 2,
        error: "second error",
      });
      expect(retriedSecond?.runAfter.getTime()).toBeGreaterThanOrEqual(
        beforeSecond.getTime() + 400 - 1,
      );
      expect(retriedSecond?.runAfter.getTime()).toBeLessThanOrEqual(
        afterSecond.getTime() + 400 + 1,
      );
      expect(await queue.claim()).toBeUndefined();

      const third = await claimWhenReady(queue);
      expect(third.attempts).toBe(3);
      const failed = await queue.fail(third, new Error("final error"));
      expect(failed).toMatchObject({
        id: job.id,
        state: "failed",
        attempts: 3,
        error: "final error",
      });
      expect(await queue.claim()).toBeUndefined();
      expect(await listJobs(db, { state: "failed" })).toMatchObject([
        { id: job.id, state: "failed", attempts: 3, error: "final error" },
      ]);
    }));

  test("completes a retried attempt and rejects stale attempts", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db, { retryDelayMs: 20 });
      const job = await queue.enqueue(probePayload());
      const first = await queue.claim();
      if (!first) throw new Error("First claim missing.");
      await queue.fail(first, "old error");
      const second = await claimWhenReady(queue);
      expect(second.attempts).toBe(2);
      expect(await queue.complete(first)).toBeUndefined();
      expect(await queue.fail(first, "stale error")).toBeUndefined();
      expect(await listJobs(db, { state: "running" })).toMatchObject([
        { id: job.id, attempts: 2, error: "old error" },
      ]);
      const completed = await queue.complete(second);
      expect(completed).toMatchObject({
        id: job.id,
        state: "completed",
        attempts: 2,
        error: "old error",
      });
      expect(await queue.fail(second, "late error")).toBeUndefined();
      expect(await queue.complete(second)).toBeUndefined();
      expect(await queue.claim()).toBeUndefined();
    }));

  test("caps the retry delay at sixty seconds", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db, { retryDelayMs: 120_000 });
      await queue.enqueue(probePayload());
      const first = await queue.claim();
      if (!first) throw new Error("First claim missing.");
      const before = await databaseNow(db);
      const retried = await queue.fail(first, "boom");
      const after = await databaseNow(db);
      expect(retried?.state).toBe("queued");
      expect(retried?.runAfter.getTime()).toBeGreaterThanOrEqual(
        before.getTime() + 60_000 - 1,
      );
      expect(retried?.runAfter.getTime()).toBeLessThanOrEqual(
        after.getTime() + 60_000 + 1,
      );
    }));

  test("claims nothing when the type filter is empty", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      await queue.enqueue(probePayload());
      expect(await queue.claim([])).toBeUndefined();
      expect(await listJobs(db, { state: "queued" })).toHaveLength(1);
    }));
});
