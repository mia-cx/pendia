import type { JobPayload } from "../db/schema/index.ts";
import type { Job } from "./queue.ts";

/** Creates a typed job-type to handler registry. */
export function createJobRegistry() {
  const handlers = new Map<Job["type"], (job: Job) => Promise<void>>();
  return {
    /** Registers a handler for a job type, narrowing its payload. */
    register<T extends Job["type"]>(
      type: T,
      handler: (
        payload: Extract<JobPayload, { type: T }>,
        job: Job,
      ) => Promise<void>,
    ) {
      if (handlers.has(type))
        throw new Error(`Job handler already registered: ${type}.`);
      handlers.set(type, async (job) => {
        if (job.payload.type !== type)
          throw new Error("Job payload does not match its handler.");
        await handler(job.payload as Extract<JobPayload, { type: T }>, job);
      });
    },
    /** Lists the registered job types workers may claim. */
    types() {
      return [...handlers.keys()];
    },
    /** Runs the handler registered for the job's type. */
    async run(job: Job) {
      const handler = handlers.get(job.type);
      if (!handler)
        throw new Error(`No handler registered for job type: ${job.type}.`);
      await handler(job);
    },
  };
}

/** The shared process job handler registry. */
export const jobRegistry = createJobRegistry();
