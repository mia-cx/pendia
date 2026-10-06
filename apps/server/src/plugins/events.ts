import type { PluginEvents } from "@thalia/plugin-api";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { jobs } from "../db/schema/index.ts";
import { jobChannel } from "../jobs/queue.ts";
import { readPluginSettings } from "./settings.ts";

/** One plugin event with its payload. */
export type PluginEvent = {
  [E in keyof PluginEvents]: { event: E; payload: PluginEvents[E] };
}[keyof PluginEvents];

/**
 * Enqueues one `plugin` job per event for every enabled plugin with the events
 * capability. Run it inside the write's transaction: the events then exist
 * exactly when the write commits, one worker delivers each, and the queue's
 * NOTIFY wakes the workers.
 */
export async function emitPluginEvents(
  db: Pick<Database, "select" | "insert" | "execute">,
  events: readonly PluginEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const { plugins } = await readPluginSettings(db);
  const listeners = Object.entries(plugins)
    .filter(
      ([, state]) => state.enabled && state.capabilities.includes("events"),
    )
    .map(([name]) => name);
  if (listeners.length === 0) return;
  await db.insert(jobs).values(
    listeners.flatMap((pluginName) =>
      events.map(({ event, payload }) => ({
        type: "plugin" as const,
        payload: {
          type: "plugin" as const,
          pluginName,
          jobId: `event:${event}`,
          data: payload,
        },
        maxAttempts: 3,
      })),
    ),
  );
  await db.execute(sql`select pg_notify(${jobChannel}, '')`);
}
