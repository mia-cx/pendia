import { withEventMeta } from "@orpc/server";
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import { Option, Schema } from "effect";
import { checkPermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { events, sessionRegistry } from "../db/schema/index.ts";
import type { Caller } from "./items.ts";
import { ApiEvent } from "./schema.ts";

/** The Postgres NOTIFY channel that carries new event ids. */
export const eventChannel = "pendia_events";

/** The number of seconds an event stays replayable. */
export const retentionSeconds = 600;

/** The longest an open stream goes without revalidating its credential. */
export const revalidateIntervalMs = 30_000;

/** A decoded API event, the shape rows publish and streams deliver. */
export type Event = Schema.Schema.Type<typeof ApiEvent>;

type PublishOptions = { retentionSeconds?: number };

/** Inserts an event, prunes rows past the retention window and notifies listeners. */
export async function publishEvent(
  db: Pick<Database, "transaction">,
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

/** Reports whether the caller is entitled to receive an event; anything unknown denies. */
export async function canReceive(
  db: Database,
  caller: Caller,
  event: Event,
): Promise<boolean> {
  switch (event.kind) {
    case "library.changed":
      return checkPermission(db, caller.user.id, "view", event.libraryId);
    case "job.progress":
      return checkPermission(db, caller.user.id, "manage-server");
    case "session.state":
    case "segment.ready": {
      const [session] = await db
        .select({ userId: sessionRegistry.userId })
        .from(sessionRegistry)
        .where(eq(sessionRegistry.id, event.sessionId))
        .limit(1);
      if (session?.userId === caller.user.id) return true;
      return checkPermission(db, caller.user.id, "manage-server");
    }
    default:
      return false;
  }
}

// The subject an audience decision attaches to: every event of a kind asking
// the same question shares one memo slot.
function subjectKey(event: Event): string {
  const { kind } = event;
  switch (kind) {
    case "library.changed":
      return `library:${event.libraryId}`;
    case "job.progress":
      return "job";
    case "session.state":
    case "segment.ready":
      return `session:${event.sessionId}`;
    default:
      // The union is exhaustive today; a future kind memoises its own denial.
      return `kind:${kind}`;
  }
}

/** Memoises an audience decider by event subject; reset() drops every decision. */
export function memoizeAudience(
  decide: (caller: Caller, event: Event) => Promise<boolean>,
) {
  const memo = new Map<string, Promise<boolean>>();
  return {
    allows(caller: Caller, event: Event): Promise<boolean> {
      const key = subjectKey(event);
      let pending = memo.get(key);
      if (pending === undefined) {
        pending = decide(caller, event);
        memo.set(key, pending);
      }
      return pending;
    },
    reset() {
      memo.clear();
    },
  };
}

type BrokerOptions = {
  pollIntervalMs?: number;
  revalidateIntervalMs?: number;
};

const batchSize = 100;
const eventIdPattern = /^\d+$/;
// The id column is a signed bigserial; a larger Last-Event-ID cannot name a
// row, so it falls through to starting from the present like any bad id.
const maxEventId = (1n << 63n) - 1n;

/** The broker returned by startEventBroker; one per api process. */
export type EventBroker = Awaited<ReturnType<typeof startEventBroker>>;

/** Starts the per-process event fan-out over a single Postgres LISTEN. */
export async function startEventBroker(
  db: Database,
  {
    pollIntervalMs = 5_000,
    revalidateIntervalMs: revalidateMs = revalidateIntervalMs,
  }: BrokerOptions = {},
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
    caller: Caller;
    revalidate: () => Promise<Caller>;
    lastEventId?: string;
    signal?: AbortSignal;
  }) {
    const { lastEventId, signal } = options;
    let caller = options.caller;
    let validatedAt = Date.now();
    const audience = memoizeAudience((current, event) =>
      canReceive(db, current, event),
    );
    // A fresh caller invalidates cached audience decisions, so authorisation
    // freshness is bounded by the same interval as credential freshness.
    const refresh = async () => {
      caller = await options.revalidate();
      validatedAt = Date.now();
      audience.reset();
    };
    let cursor: bigint;
    const requested =
      lastEventId !== undefined && eventIdPattern.test(lastEventId)
        ? BigInt(lastEventId)
        : undefined;
    if (requested !== undefined && requested <= maxEventId) {
      cursor = requested;
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
      if (rows.length > 0) await refresh();
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
        // A yield suspends until the consumer pulls, so a batch can outlive
        // the interval; revalidate before authorising each row past it.
        if (Date.now() - validatedAt >= revalidateMs) await refresh();
        if (await audience.allows(caller, decoded.value))
          yield withEventMeta(decoded.value, { id: String(row.id) });
      }
      if (rows.length === batchSize) continue;
      await wait(version, signal);
      if (
        !stopped &&
        !signal?.aborted &&
        Date.now() - validatedAt >= revalidateMs
      )
        await refresh();
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
