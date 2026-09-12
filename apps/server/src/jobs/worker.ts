import type { Database } from "../db/client.ts";
import { createJobQueue, type Job, jobChannel } from "./queue.ts";
import { jobRegistry } from "./registry.ts";

type WorkerOptions = {
  concurrency?: number;
  pollIntervalMs?: number;
  queueOptions?: Parameters<typeof createJobQueue>[1];
  onError?: (error: unknown) => void;
};

/** Starts worker loops that claim and run registered jobs until stopped. */
export async function startJobWorker(
  db: Database,
  registry = jobRegistry,
  {
    concurrency = 4,
    pollIntervalMs = 5_000,
    queueOptions,
    onError = console.error,
  }: WorkerOptions = {},
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Worker concurrency must be a positive integer.");
  if (
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0 ||
    pollIntervalMs > 2_147_483_647
  )
    throw new Error("Poll interval must be a positive timer delay.");
  const queue = createJobQueue(db, queueOptions);
  let stopped = false;
  let generation = 0;
  const waiters = new Set<() => void>();
  function wake() {
    generation++;
    for (const finish of waiters) finish();
  }
  function wait(version: number) {
    if (stopped || generation !== version) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, pollIntervalMs);
      waiters.add(finish);
    });
  }
  async function execute(job: Job) {
    try {
      await registry.run(job);
    } catch (error) {
      await queue.fail(job, error);
      return;
    }
    await queue.complete(job);
  }
  const subscription = await db.$client.listen(jobChannel, wake, wake);
  async function loop() {
    while (!stopped) {
      const version = generation;
      try {
        const job = await queue.claim(registry.types());
        if (job) {
          await execute(job);
          wake();
          continue;
        }
      } catch (error) {
        onError(error);
      }
      await wait(version);
    }
  }
  const loops = Array.from({ length: concurrency }, () => loop());
  let stopping: Promise<void> | undefined;
  return {
    /** Stops claiming, waits for active handlers and unlistens. */
    stop() {
      stopping ??= (async () => {
        stopped = true;
        wake();
        try {
          await Promise.all(loops);
        } finally {
          await subscription.unlisten();
        }
      })();
      return stopping;
    },
  };
}
