import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { type JobPayload, jobs, jobType } from "../db/schema/index.ts";

/** A persisted queue job. */
export type Job = typeof jobs.$inferSelect;

type EnqueueOptions = Partial<
  Pick<
    typeof jobs.$inferInsert,
    "priority" | "maxAttempts" | "runAfter" | "concurrencyKey"
  >
>;

const claimLockKey = 0x70656e646a6fn;
const maxRetryDelayMs = 60_000;

/** The Postgres NOTIFY channel that wakes idle workers. */
export const jobChannel = "pendia_jobs";

type QueueOptions = { retryDelayMs?: number; concurrencyLimit?: number };

/** Creates queue operations on the shared Postgres database. */
export function createJobQueue(
  db: Database,
  { retryDelayMs = 1_000, concurrencyLimit = 1 }: QueueOptions = {},
) {
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0)
    throw new Error("Retry delay must be positive and finite.");
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1)
    throw new Error("Concurrency limit must be a positive integer.");
  return {
    /** Enqueues a typed payload with its scheduling options. */
    async enqueue(payload: JobPayload, options: EnqueueOptions = {}) {
      return db.transaction(async (tx) => {
        const [job] = await tx
          .insert(jobs)
          .values({
            ...options,
            type: payload.type,
            payload,
            maxAttempts: options.maxAttempts ?? 3,
          })
          .returning();
        if (!job) throw new Error("Job insertion returned no row.");
        await tx.execute(sql`select pg_notify(${jobChannel}, '')`);
        return job;
      });
    },

    /** Claims the highest-priority ready job once across workers. */
    async claim(types: readonly Job["type"][] = jobType.enumValues) {
      if (types.length === 0) return undefined;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${claimLockKey})`);
        const [job] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.state, "queued"),
              lt(jobs.attempts, jobs.maxAttempts),
              lte(jobs.runAfter, sql`now()`),
              inArray(jobs.type, [...types]),
              or(
                isNull(jobs.concurrencyKey),
                sql`(select count(*) from ${jobs} as running_jobs where running_jobs.state = 'running' and running_jobs.concurrency_key = ${jobs.concurrencyKey}) < ${concurrencyLimit}`,
              ),
            ),
          )
          .orderBy(desc(jobs.priority), jobs.runAfter, jobs.id)
          .limit(1)
          .for("update", { skipLocked: true });
        if (!job) return undefined;
        const [claimed] = await tx
          .update(jobs)
          .set({ state: "running", attempts: sql`${jobs.attempts} + 1` })
          .where(eq(jobs.id, job.id))
          .returning();
        return claimed;
      });
    },

    /** Completes only the currently running attempt. */
    async complete(job: Pick<Job, "id" | "attempts">) {
      const [completed] = await db
        .update(jobs)
        .set({ state: "completed" })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.state, "running"),
            eq(jobs.attempts, job.attempts),
          ),
        )
        .returning();
      return completed;
    },

    /** Retains the error and schedules a retry unless attempts are exhausted. */
    async fail(job: Pick<Job, "id" | "attempts">, error: unknown) {
      const delay = Math.min(
        maxRetryDelayMs,
        retryDelayMs * 2 ** (job.attempts - 1),
      );
      const [failed] = await db
        .update(jobs)
        .set({
          state: sql`case when ${jobs.attempts} < ${jobs.maxAttempts} then 'queued'::job_state else 'failed'::job_state end`,
          error: error instanceof Error ? error.message : String(error),
          runAfter: sql`case when ${jobs.attempts} < ${jobs.maxAttempts} then clock_timestamp() + ${delay} * interval '1 millisecond' else ${jobs.runAfter} end`,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.state, "running"),
            eq(jobs.attempts, job.attempts),
          ),
        )
        .returning();
      return failed;
    },
  };
}

/** Lists jobs for the admin, with optional state and type filters. */
export async function listJobs(
  db: Database,
  options: {
    state?: Job["state"];
    type?: Job["type"];
    limit?: number;
    offset?: number;
  } = {},
) {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        options.state ? eq(jobs.state, options.state) : undefined,
        options.type ? eq(jobs.type, options.type) : undefined,
      ),
    )
    .orderBy(desc(jobs.id))
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0);
}
