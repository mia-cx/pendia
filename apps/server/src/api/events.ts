import { withEventMeta } from "@orpc/server";
import { asc, desc, gt, sql } from "drizzle-orm";
import { Option, Schema } from "effect";
import type { Database } from "../db/client.ts";
import { events } from "../db/schema/index.ts";
import { ApiEvent } from "./schema.ts";

/** The Postgres NOTIFY channel that carries new event ids. */
export const eventChannel = "pendia_events";

/** The number of seconds an event stays replayable. */
export const retentionSeconds = 600;

/** A decoded API event, the shape rows publish and streams deliver. */
export type Event = Schema.Schema.Type<typeof ApiEvent>;

type PublishOptions = { retentionSeconds?: number };

/** Inserts an event, prunes rows past the retention window and notifies listeners. */
export async function publishEvent(
  db: Database,
  event: Event,
  options: PublishOptions = {},
): Promise<bigint> {
  const retention = options.retentionSeconds ?? retentionSeconds;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(events)
      .values({ kind: event.kind, payload: event })
      .returning({ id: events.id });
    if (!row) throw new Error("Event insert returned no row.");
    await tx
      .delete(events)
      .where(
        sql`${events.createdAt} < clock_timestamp() - ${retention} * interval '1 second'`,
      );
    await tx.execute(
      sql`select pg_notify(${eventChannel}, ${row.id.toString()})`,
    );
    return row.id;
  });
}

type BrokerOptions = { pollIntervalMs?: number };

const batchSize = 100;
const eventIdPattern = /^\d+$/;

/** The broker returned by startEventBroker; one per api process. */
export type EventBroker = Awaited<ReturnType<typeof startEventBroker>>;

/** Starts the per-process event fan-out over a single Postgres LISTEN. */
export async function startEventBroker(
  db: Database,
  { pollIntervalMs = 5_000 }: BrokerOptions = {},
) {
  let stopped = false;
  let generation = 0;
  const waiters = new Set<() => void>();
  function wake() {
    generation++;
    for (const finish of waiters) finish();
  }
  function wait(version: number, signal?: AbortSignal) {
    if (stopped || generation !== version || signal?.aborted)
      return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, pollIntervalMs);
      signal?.addEventListener("abort", finish, { once: true });
      waiters.add(finish);
    });
  }
  const subscription = await db.$client.listen(eventChannel, wake, wake);

  async function* subscribe(options: {
    lastEventId?: string;
    signal?: AbortSignal;
  }) {
    const { lastEventId, signal } = options;
    let cursor: bigint;
    if (lastEventId !== undefined && eventIdPattern.test(lastEventId)) {
      cursor = BigInt(lastEventId);
    } else {
      const [latest] = await db
        .select({ id: events.id })
        .from(events)
        .orderBy(desc(events.id))
        .limit(1);
      cursor = latest?.id ?? 0n;
    }
    while (!stopped && !signal?.aborted) {
      const version = generation;
      const rows = await db
        .select({ id: events.id, payload: events.payload })
        .from(events)
        .where(gt(events.id, cursor))
        .orderBy(asc(events.id))
        .limit(batchSize);
      for (const row of rows) {
        cursor = row.id;
        const decoded = Schema.decodeUnknownOption(ApiEvent)(row.payload);
        if (Option.isNone(decoded)) {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "api.event.undecodable",
              eventId: String(row.id),
            }),
          );
          continue;
        }
        yield withEventMeta(decoded.value, { id: String(row.id) });
      }
      if (rows.length === batchSize) continue;
      await wait(version, signal);
    }
  }

  let stopping: Promise<void> | undefined;
  return {
    subscribe,
    /** Stops the loops and drops the LISTEN connection, once. */
    stop() {
      stopping ??= (async () => {
        stopped = true;
        wake();
        await subscription.unlisten();
      })();
      return stopping;
    },
  };
}
