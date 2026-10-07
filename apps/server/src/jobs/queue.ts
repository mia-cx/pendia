import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  type JobPayload,
  jobs,
  jobType,
  libraries,
} from "../db/schema/index.ts";

/** A persisted queue job. */
export type Job = typeof jobs.$inferSelect;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;

type EnqueueOptions = Partial<
  Pick<
    typeof jobs.$inferInsert,
    "priority" | "maxAttempts" | "runAfter" | "concurrencyKey"
  >
>;

const claimLockKey = 0x70656e646a6fn;
const maxRetryDelayMs = 60_000;

/** How long a watcher's claim keeps its Libraries' scans away from workers. */
export const watcherHeartbeatMs = 30_000;

/** The Postgres NOTIFY channel that wakes idle workers. */
export const jobChannel = "thalia_jobs";

/** The error a job keeps when its holder stopped renewing its lease. */
export const leaseExpiredError =
  "Job lease expired before its holder finished.";

const maxTimerDelayMs = 2_147_483_647;

/** The job fields that identify one claim of it. */
type Claim = Pick<Job, "id" | "claimToken">;

type QueueOptions = {
  retryDelayMs?: number;
  concurrencyLimit?: number;
  /** How long a claim or renewal keeps a running job from other claims. */
  leaseMs?: number;
  /** How often `hold` renews the lease while its work runs. */
  renewMs?: number;
};

/** Creates queue operations on the shared Postgres database. */
export function createJobQueue(
  db: Connection,
  {
    retryDelayMs = 1_000,
    concurrencyLimit = 1,
    leaseMs = 60_000,
    renewMs = 20_000,
  }: QueueOptions = {},
) {
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0)
    throw new Error("Retry delay must be positive and finite.");
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1)
    throw new Error("Concurrency limit must be a positive integer.");
  if (!(renewMs > 0 && renewMs < leaseMs && leaseMs <= maxTimerDelayMs))
    throw new Error("Lease renewal must be a positive delay below the lease.");
  const leaseEnd = sql`statement_timestamp() + ${leaseMs} * interval '1 millisecond'`;
  const leaseExpired = and(
    eq(jobs.state, "running"),
    lt(jobs.leaseExpiresAt, sql`statement_timestamp()`),
  );

  /**
   * Extends a live lease; false means it expired, another claim took the job
   * or it settled. Renewing under the claim lock keeps a lease that a claim
   * already counted as expired from coming back into its concurrency key.
   */
  async function renew(job: Claim) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${claimLockKey})`);
      const renewed = await tx
        .update(jobs)
        .set({ leaseExpiresAt: leaseEnd })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.claimToken, job.claimToken),
            eq(jobs.state, "running"),
            gte(jobs.leaseExpiresAt, sql`statement_timestamp()`),
          ),
        )
        .returning({ id: jobs.id });
      return renewed.length > 0;
    });
  }

  return {
    renew,

    /**
     * Runs `work` while renewing the job's lease every `renewMs`, and stops
     * renewing when it settles. Renewal errors and a lost lease go to `onError`.
     */
    async hold<T>(
      job: Claim,
      work: () => Promise<T>,
      onError: (error: unknown) => void = console.error,
    ) {
      let holding = true;
      const timer = setInterval(() => {
        renew(job).then((held) => {
          if (held || !holding) return;
          clearInterval(timer);
          onError(new Error(`Lost the lease on job ${job.id}.`));
        }, onError);
      }, renewMs);
      try {
        return await work();
      } finally {
        holding = false;
        clearInterval(timer);
      }
    },

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

    /**
     * Claims the highest-priority ready job once across workers, with a fresh
     * claim token and lease. A running job whose lease expired is ready again
     * as its next attempt. Scans of a Library with a live watcher are left to
     * that watcher, which claims them by passing its `libraryIds`.
     */
    async claim(
      types: readonly Job["type"][] = jobType.enumValues,
      { libraryIds }: { libraryIds?: readonly string[] } = {},
    ) {
      if (types.length === 0) return undefined;
      const libraryId = sql`${jobs.payload}->>'libraryId'`;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${claimLockKey})`);
        // An expired lease on the last attempt leaves nothing to reclaim.
        await tx
          .update(jobs)
          .set({ state: "failed", error: leaseExpiredError })
          .where(and(leaseExpired, gte(jobs.attempts, jobs.maxAttempts)));
        const [job] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              or(
                and(
                  eq(jobs.state, "queued"),
                  lte(jobs.runAfter, sql`statement_timestamp()`),
                ),
                leaseExpired,
              ),
              lt(jobs.attempts, jobs.maxAttempts),
              inArray(jobs.type, [...types]),
              libraryIds === undefined
                ? or(
                    ne(jobs.type, "scan"),
                    sql`not exists (select 1 from ${libraries} where ${libraries.id}::text = ${libraryId} and ${libraries.watcherSeenAt} > statement_timestamp() - ${watcherHeartbeatMs} * interval '1 millisecond')`,
                  )
                : and(
                    eq(jobs.type, "scan"),
                    inArray(libraryId, [...libraryIds]),
                  ),
              // Only live leases hold a key: an expired job must not block its own reclaim.
              or(
                isNull(jobs.concurrencyKey),
                sql`(select count(*) from ${jobs} as running_jobs where running_jobs.state = 'running' and running_jobs.lease_expires_at >= statement_timestamp() and running_jobs.concurrency_key = ${jobs.concurrencyKey}) < ${concurrencyLimit}`,
              ),
            ),
          )
          .orderBy(desc(jobs.priority), jobs.runAfter, jobs.id)
          .limit(1)
          .for("update", { skipLocked: true });
        if (!job) return undefined;
        const [claimed] = await tx
          .update(jobs)
          .set({
            state: "running",
            attempts: sql`${jobs.attempts} + 1`,
            claimToken: crypto.randomUUID(),
            leaseExpiresAt: leaseEnd,
            error: job.state === "running" ? leaseExpiredError : job.error,
          })
          .where(eq(jobs.id, job.id))
          .returning();
        return claimed;
      });
    },

    /** Completes the job only for the claim that holds it. */
    async complete(job: Claim) {
      const [completed] = await db
        .update(jobs)
        .set({ state: "completed" })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.claimToken, job.claimToken),
            eq(jobs.state, "running"),
          ),
        )
        .returning();
      return completed;
    },

    /**
     * Retains the error and schedules a retry unless attempts are exhausted,
     * only for the claim that holds the job.
     */
    async fail(job: Claim & Pick<Job, "attempts">, error: unknown) {
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
            eq(jobs.claimToken, job.claimToken),
            eq(jobs.state, "running"),
          ),
        )
        .returning();
      return failed ? { ...failed, retryDelayMs: delay } : undefined;
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
