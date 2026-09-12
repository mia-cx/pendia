import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
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

/** Creates queue operations on the shared Postgres database. */
export function createJobQueue(db: Database) {
  return {
    /** Enqueues a typed payload with its scheduling options. */
    async enqueue(payload: JobPayload, options: EnqueueOptions = {}) {
      const [job] = await db
        .insert(jobs)
        .values({
          ...options,
          type: payload.type,
          payload,
          maxAttempts: options.maxAttempts ?? 3,
        })
        .returning();
      if (!job) throw new Error("Job insertion returned no row.");
      return job;
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
