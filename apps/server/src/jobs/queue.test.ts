import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { type JobPayload, jobs } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, leaseExpiredError, listJobs } from "./queue.ts";

function probePayload(): JobPayload {
  return { type: "probe", fileId: Bun.randomUUIDv7() };
}

async function databaseNow(db: Database) {
  const [row] = await db.$client<{ now: Date }[]>`select now() as now`;
  if (!row) throw new Error("Database clock query returned no row.");
  return row.now;
}

/** Ends a job's lease now, the way a holder that stopped renewing would. */
async function expireLease(db: Database, id: string) {
  await db
    .update(jobs)
    .set({ leaseExpiresAt: sql`statement_timestamp() - interval '1 second'` })
    .where(eq(jobs.id, id));
}

async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not met in time.");
    await Bun.sleep(10);
  }
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

test("rejects invalid retry delays and concurrency limits", async () => {
  const lazy = createDatabase("postgresql://pendia:pendia@127.0.0.1:1/unused");
  try {
    for (const retryDelayMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => createJobQueue(lazy.db, { retryDelayMs })).toThrow(
        "Retry delay must be positive and finite.",
      );
    for (const concurrencyLimit of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(() => createJobQueue(lazy.db, { concurrencyLimit })).toThrow(
        "Concurrency limit must be a positive integer.",
      );
    for (const lease of [
      { renewMs: 0 },
      { leaseMs: 20_000 },
      { renewMs: Number.NaN },
      { leaseMs: Number.POSITIVE_INFINITY },
    ])
      expect(() => createJobQueue(lazy.db, lease)).toThrow(
        "Lease renewal must be a positive delay below the lease.",
      );
  } finally {
    await lazy.close();
  }
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

  test("caps concurrent jobs sharing a key across independent clients", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db, { concurrencyLimit: 2 });
      const second = createDatabase(url);
      try {
        const secondQueue = createJobQueue(second.db, {
          concurrencyLimit: 2,
        });
        await Promise.all(
          Array.from({ length: 8 }, () =>
            queue.enqueue(probePayload(), { concurrencyKey: "library-a" }),
          ),
        );
        const claimed = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            (index % 2 === 0 ? queue : secondQueue).claim(),
          ),
        );
        const claimedJobs = claimed.filter((job) => job !== undefined);
        expect(claimedJobs).toHaveLength(2);
        expect(await listJobs(db, { state: "running" })).toHaveLength(2);
        expect(await listJobs(db, { state: "queued" })).toHaveLength(6);

        const [done, other] = claimedJobs;
        if (!done || !other) throw new Error("Claimed jobs missing.");
        await queue.complete(done);
        const freed = await queue.claim();
        expect(freed).toBeDefined();
        expect([done.id, other.id]).not.toContain(freed?.id);

        await queue.fail(other, "retry later");
        const next = await queue.claim();
        expect(next).toBeDefined();
        expect(next?.id).not.toBe(other.id);
        expect(await listJobs(db, { state: "running" })).toHaveLength(2);
      } finally {
        await second.close();
      }
    }));

  test("defaults to one running job per key and frees it on completion", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const a1 = await queue.enqueue(probePayload(), {
        priority: 10,
        concurrencyKey: "a",
      });
      const a2 = await queue.enqueue(probePayload(), {
        priority: 9,
        concurrencyKey: "a",
      });
      const b = await queue.enqueue(probePayload(), {
        priority: 1,
        concurrencyKey: "b",
      });
      const c = await queue.enqueue(probePayload());
      const d = await queue.enqueue(probePayload());
      const first = await queue.claim();
      expect(first?.id).toBe(a1.id);
      const claimed = await Promise.all([
        queue.claim(),
        queue.claim(),
        queue.claim(),
      ]);
      expect(new Set(claimed.map((job) => job?.id))).toEqual(
        new Set([b.id, c.id, d.id]),
      );
      expect(await queue.claim()).toBeUndefined();
      if (!first) throw new Error("First claim missing.");
      await queue.complete(first);
      const released = await queue.claim();
      expect(released?.id).toBe(a2.id);
    }));

  test("claim rechecks eligibility after waiting on the claim lock", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const second = createDatabase(url);
      let pending: ReturnType<typeof queue.claim> | undefined;
      let expectedId: string | undefined;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(${0x70656e646a6fn})`,
          );
          const job = await queue.enqueue(probePayload(), {
            runAfter: new Date((await databaseNow(db)).getTime() + 250),
          });
          expectedId = job.id;
          const secondQueue = createJobQueue(second.db);
          pending = secondQueue.claim();
          const deadline = Date.now() + 1_000;
          for (;;) {
            const rows = await db.$client<
              { count: number }[]
            >`select count(*)::integer as count from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`;
            if ((rows[0]?.count ?? 0) > 0) break;
            if (Date.now() > deadline)
              throw new Error("Pending claim lock wait was not observed.");
            await Bun.sleep(10);
          }
          await Bun.sleep(300);
        });
        if (!pending) throw new Error("Pending claim was not started.");
        const claimed = await pending;
        expect(claimed?.id).toBe(expectedId);
      } finally {
        await second.close();
      }
    }));

  test("a crashed holder's job is reclaimed, and its late answers change nothing", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const job = await queue.enqueue(probePayload(), {
        concurrencyKey: "library",
      });
      const crashed = await queue.claim();
      if (!crashed) throw new Error("First claim missing.");
      expect(crashed.leaseExpiresAt.getTime()).toBeGreaterThan(
        (await databaseNow(db)).getTime(),
      );
      expect(await queue.claim()).toBeUndefined();
      await expireLease(db, job.id);
      const reclaimed = await queue.claim();
      expect(reclaimed).toMatchObject({
        id: job.id,
        state: "running",
        attempts: 2,
        error: leaseExpiredError,
      });
      expect(reclaimed?.claimToken).not.toBe(crashed.claimToken);
      expect(await queue.complete(crashed)).toBeUndefined();
      expect(await queue.fail(crashed, "late error")).toBeUndefined();
      expect(await queue.renew(crashed)).toBe(false);
      if (!reclaimed) throw new Error("Reclaim missing.");
      expect(await queue.complete(reclaimed)).toMatchObject({
        id: job.id,
        state: "completed",
        attempts: 2,
      });
    }));

  test("a job that keeps losing its lease ends failed with the lease error", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db);
      const job = await queue.enqueue(probePayload(), { maxAttempts: 2 });
      for (const attempts of [1, 2]) {
        expect((await queue.claim())?.attempts).toBe(attempts);
        await expireLease(db, job.id);
      }
      expect(await queue.claim()).toBeUndefined();
      expect(await listJobs(db)).toMatchObject([
        { id: job.id, state: "failed", attempts: 2, error: leaseExpiredError },
      ]);
    }));

  test("hold renews the lease while its work runs and reports a lost lease", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const queue = createJobQueue(db, { leaseMs: 1_000, renewMs: 20 });
      const job = await queue.enqueue(probePayload());
      const claimed = await queue.claim();
      if (!claimed) throw new Error("Claim missing.");
      const errors: unknown[] = [];
      await queue.hold(
        claimed,
        async () => {
          const lease = async () =>
            (await listJobs(db))[0]?.leaseExpiresAt.getTime() ?? 0;
          await until(
            async () => (await lease()) > claimed.leaseExpiresAt.getTime(),
          );
          expect(await queue.claim()).toBeUndefined();
          await expireLease(db, job.id);
          expect((await queue.claim())?.attempts).toBe(2);
          await until(async () => errors.length > 0);
        },
        (error) => errors.push(error),
      );
      expect(errors).toEqual([new Error(`Lost the lease on job ${job.id}.`)]);
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
