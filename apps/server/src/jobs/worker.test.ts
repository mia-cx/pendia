import { describe, expect, spyOn, test } from "bun:test";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { type JobPayload, jobs } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue, type Job, listJobs } from "./queue.ts";
import { createJobRegistry } from "./registry.ts";
import { startJobWorker } from "./worker.ts";

function probePayload(): Extract<JobPayload, { type: "probe" }> {
  return { type: "probe", fileId: Bun.randomUUIDv7() };
}

function fakeJob(payload: JobPayload): Job {
  return {
    id: Bun.randomUUIDv7(),
    type: payload.type,
    payload,
    priority: 0,
    attempts: 1,
    maxAttempts: 3,
    runAfter: new Date(),
    concurrencyKey: null,
    state: "running",
    error: null,
  };
}

async function waitForJobState(db: Database, id: string, state: Job["state"]) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = (await listJobs(db)).find((row) => row.id === id);
    if (job?.state === state) return job;
    await Bun.sleep(10);
  }
  throw new Error(`Job ${id} did not reach state ${state}.`);
}

test("registers typed handlers and rejects duplicates and missing types", async () => {
  const registry = createJobRegistry();
  const seen: string[] = [];
  registry.register("probe", async (payload, job) => {
    seen.push(`${payload.fileId}:${job.attempts}`);
  });
  expect(() => registry.register("probe", async () => {})).toThrow(
    "Job handler already registered: probe.",
  );
  await registry.run(fakeJob({ type: "probe", fileId: "file-1" }));
  expect(seen).toEqual(["file-1:1"]);
  expect(registry.types()).toEqual(["probe"]);
  await expect(
    registry.run(fakeJob({ type: "scan", libraryId: "l", path: "/x" })),
  ).rejects.toThrow("No handler registered for job type: scan.");
});

describe.skipIf(!databaseUrl)("Job worker", () => {
  test("dispatches registered handlers and leaves unknown types queued", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const registry = createJobRegistry();
      const seen: { fileId: string; attempts: number }[] = [];
      registry.register("probe", async (payload, job) => {
        seen.push({ fileId: payload.fileId, attempts: job.attempts });
      });
      const queue = createJobQueue(db);
      const payload = probePayload();
      const probe = await queue.enqueue(payload);
      const scan = await queue.enqueue({
        type: "scan",
        libraryId: Bun.randomUUIDv7(),
        path: "/shows",
      });
      const worker = await startJobWorker(db, registry, {
        pollIntervalMs: 20,
      });
      try {
        const completed = await waitForJobState(db, probe.id, "completed");
        expect(completed.payload).toEqual(payload);
        expect(seen).toEqual([{ fileId: payload.fileId, attempts: 1 }]);
        const [scanRow] = await listJobs(db, { state: "queued" });
        expect(scanRow).toMatchObject({
          id: scan.id,
          type: "scan",
          attempts: 0,
        });
      } finally {
        await worker.stop();
      }
    }));

  test("wakes an idle worker through NOTIFY before the poll fallback", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      let invoked = Promise.withResolvers<string>();
      const registry = createJobRegistry();
      registry.register("probe", async (payload) => {
        invoked.resolve(payload.fileId);
      });
      const queue = createJobQueue(db);
      const worker = await startJobWorker(db, registry, {
        concurrency: 1,
        pollIntervalMs: 10_000,
      });
      const producer = createDatabase(url);
      try {
        const warmup = await queue.enqueue(probePayload());
        await waitForJobState(db, warmup.id, "completed");
        await Bun.sleep(30);

        invoked = Promise.withResolvers();
        const producerQueue = createJobQueue(producer.db);
        const payload = probePayload();
        const job = await producerQueue.enqueue(payload);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const fileId = await Promise.race([
          invoked.promise,
          new Promise<never>((_, reject) => {
            // The poll fallback waits ten seconds, so completion within two
            // seconds proves the NOTIFY wake without imposing a latency target.
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "NOTIFY did not wake worker before the poll fallback.",
                  ),
                ),
              2_000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        expect(fileId).toBe(payload.fileId);
        await waitForJobState(db, job.id, "completed");
      } finally {
        await worker.stop();
        await producer.close();
      }
    }));

  test("picks up jobs without NOTIFY through the poll fallback", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      let invoked = Promise.withResolvers<string>();
      const registry = createJobRegistry();
      registry.register("probe", async (payload) => {
        invoked.resolve(payload.fileId);
      });
      const queue = createJobQueue(db);
      const worker = await startJobWorker(db, registry, {
        concurrency: 1,
        pollIntervalMs: 200,
      });
      const producer = createDatabase(url);
      try {
        const warmup = await queue.enqueue(probePayload());
        await waitForJobState(db, warmup.id, "completed");
        await Bun.sleep(30);

        invoked = Promise.withResolvers();
        const payload = probePayload();
        const [job] = await producer.db
          .insert(jobs)
          .values({ type: payload.type, payload, maxAttempts: 3 })
          .returning();
        if (!job) throw new Error("Direct job insert returned no row.");
        const fileId = await Promise.race([
          invoked.promise,
          Bun.sleep(2_000).then(() => {
            throw new Error("Poll fallback never claimed the job.");
          }),
        ]);
        expect(fileId).toBe(payload.fileId);
        await waitForJobState(db, job.id, "completed");
      } finally {
        await worker.stop();
        await producer.close();
      }
    }));

  test("retries a throwing handler and stores the terminal error", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      let calls = 0;
      const registry = createJobRegistry();
      registry.register("probe", async () => {
        calls++;
        throw new Error("handler failed");
      });
      const queue = createJobQueue(db);
      const job = await queue.enqueue(probePayload(), { maxAttempts: 2 });
      const worker = await startJobWorker(db, registry, {
        concurrency: 1,
        pollIntervalMs: 20,
        queueOptions: { retryDelayMs: 40 },
      });
      try {
        const failed = await waitForJobState(db, job.id, "failed");
        expect(calls).toBe(2);
        expect(failed).toMatchObject({
          attempts: 2,
          error: "handler failed",
        });
        await Bun.sleep(80);
        expect(calls).toBe(2);
      } finally {
        await worker.stop();
      }
    }));

  test("wakes for a scheduled retry before the poll interval despite host clock offset", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const calls: number[] = [];
      const registry = createJobRegistry();
      registry.register("probe", async () => {
        calls.push(performance.now());
        if (calls.length === 1) throw new Error("retry");
      });
      const queue = createJobQueue(db);
      const worker = await startJobWorker(db, registry, { concurrency: 1 });
      const realNow = Date.now;
      const clock = spyOn(Date, "now").mockImplementation(
        () => realNow() + 60_000,
      );
      try {
        const job = await queue.enqueue(probePayload(), { maxAttempts: 2 });
        const completed = await waitForJobState(db, job.id, "completed");
        expect(calls).toHaveLength(2);
        expect(completed).toMatchObject({ attempts: 2, error: "retry" });
        const first = calls[0];
        const second = calls[1];
        if (first === undefined || second === undefined)
          throw new Error("Retry calls missing.");
        expect(second - first).toBeGreaterThanOrEqual(990);
        expect(second - first).toBeLessThan(2_000);
      } finally {
        try {
          await worker.stop();
        } finally {
          clock.mockRestore();
        }
      }
    }));

  test("stops after active handlers finish without claiming again", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const registry = createJobRegistry();
      registry.register("probe", async () => {
        entered.resolve();
        await release.promise;
      });
      const queue = createJobQueue(db);
      const first = await queue.enqueue(probePayload());
      const secondJob = await queue.enqueue(probePayload());
      const worker = await startJobWorker(db, registry, {
        concurrency: 1,
        pollIntervalMs: 10_000,
      });
      try {
        await entered.promise;
        const stopStart = performance.now();
        let stopped = false;
        const stopping = worker.stop().then(() => {
          stopped = true;
        });
        await Bun.sleep(20);
        expect(stopped).toBe(false);
        release.resolve();
        await stopping;
        expect(performance.now() - stopStart).toBeLessThan(500);
        await worker.stop();
        await waitForJobState(db, first.id, "completed");
        expect(await listJobs(db, { state: "queued" })).toMatchObject([
          { id: secondJob.id, attempts: 0 },
        ]);
      } finally {
        release.resolve();
        await worker.stop();
      }
    }));

  test("runs up to the worker concurrency in parallel", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      let active = 0;
      let peak = 0;
      const release = Promise.withResolvers<void>();
      const registry = createJobRegistry();
      registry.register("probe", async () => {
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
      });
      const queue = createJobQueue(db);
      const enqueued = await Promise.all(
        Array.from({ length: 3 }, () => queue.enqueue(probePayload())),
      );
      const worker = await startJobWorker(db, registry, {
        concurrency: 2,
        pollIntervalMs: 10_000,
      });
      try {
        const deadline = Date.now() + 2_000;
        while (active < 2 && Date.now() < deadline) await Bun.sleep(10);
        expect(active).toBe(2);
        expect(await listJobs(db, { state: "running" })).toHaveLength(2);
        expect(await listJobs(db, { state: "queued" })).toHaveLength(1);
        release.resolve();
        for (const job of enqueued)
          await waitForJobState(db, job.id, "completed");
        expect(peak).toBe(2);
      } finally {
        release.resolve();
        await worker.stop();
      }
    }));
});
