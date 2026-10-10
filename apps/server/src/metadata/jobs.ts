import type {
  ItemKind,
  MetadataProvider,
  MetadataResult,
} from "@thalia/plugin-api";
import { and, eq, lte, sql } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  episodes,
  items,
  type JobPayload,
  jobs,
  seasons,
  shows,
} from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { emitPluginEvents } from "../plugins/events.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import { queueSubtitleFetch } from "../subtitles/jobs.ts";
import { applyArtworkSelection } from "./artwork-selection.ts";
import { metadataProviders } from "./providers.ts";
import { applyMetadata } from "./service.ts";

/** Options a manual selection carries through deferred fetching and Show descendants. */
export type ProviderFetchOptions = Pick<
  Extract<JobPayload, { type: "provider-fetch" }>,
  "provider" | "artworkPolicy"
>;

/** Queues a fetch or updates a due one, retaining explicit selection options across ordinary scan requests. */
export async function queueProviderFetch(
  db: Database,
  itemId: string,
  priority = 0,
  options: ProviderFetchOptions = {},
) {
  const concurrencyKey = `provider:${itemId}`;
  // A running fetch never blocks: a pending Item after a provider change
  // earns one queued successor that replays the fetch. A weekly refresh
  // queued for later is not due yet, so it never absorbs a fetch.
  const [due] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "provider-fetch"),
        eq(jobs.concurrencyKey, concurrencyKey),
        eq(jobs.state, "queued"),
        lte(jobs.runAfter, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  if (due === undefined)
    return createJobQueue(db).enqueue(
      { type: "provider-fetch", itemId, ...options },
      { concurrencyKey, priority },
    );
  if (due.priority >= priority && Object.keys(options).length === 0) return due;
  const [raised] = await db
    .update(jobs)
    .set({
      priority: sql`greatest(${jobs.priority}, ${priority})`,
      payload: sql`${jobs.payload} || ${JSON.stringify(options)}::text::jsonb`,
    })
    .where(and(eq(jobs.id, due.id), eq(jobs.state, "queued")))
    .returning();
  if (raised !== undefined) return raised;
  // A worker claimed the due job during the update; the manual selection still needs a successor.
  return queueProviderFetch(db, itemId, priority, options);
}

// Background scans queue at 0, so a manual refresh runs ahead of them.
const manualRefreshPriority = 1;

/** Queues a provider-fetch for one Item on demand, for a caller holding manage-libraries. */
export async function refreshItem(db: Database, actorId: string, id: string) {
  await requirePermission(db, actorId, "manage-libraries");
  const [item] = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.id, id));
  if (!item) throw new AuthError("NOT_FOUND");
  const job = await queueProviderFetch(db, item.id, manualRefreshPriority);
  return { jobId: job.id };
}

const weekMs = 7 * 24 * 60 * 60 * 1000;

/** Keeps exactly one weekly refresh queued for a continuing Show and none for any other. */
export async function scheduleWeeklyRefresh(db: Database, showId: string) {
  const concurrencyKey = `provider:${showId}`;
  await db.transaction(async (tx) => {
    // The Show row lock serializes two fetches of one Show finishing at once.
    const [show] = await tx
      .select({ status: shows.status })
      .from(shows)
      .where(eq(shows.itemId, showId))
      .for("update");
    await tx
      .delete(jobs)
      .where(
        and(
          eq(jobs.type, "provider-fetch"),
          eq(jobs.concurrencyKey, concurrencyKey),
          eq(jobs.state, "queued"),
          sql`${jobs.payload}->>'weekly' = 'true'`,
        ),
      );
    if (show?.status !== "continuing") return;
    await createJobQueue(tx).enqueue(
      { type: "provider-fetch", itemId: showId, weekly: true },
      { concurrencyKey, runAfter: new Date(Date.now() + weekMs) },
    );
  });
}

async function emitItemUpdated(db: Database, itemId: string) {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ kind: items.kind })
      .from(items)
      .where(eq(items.id, itemId));
    if (item)
      await emitPluginEvents(tx, [
        { event: "item.updated", payload: { itemId, kind: item.kind } },
      ]);
  });
}

type ArtworkType = MetadataResult["artwork"][number]["type"];

/** The artwork a fetch stores per kind: the primary image first, then the hero images Home and the detail pages draw. */
const storedArtwork = {
  movie: ["poster", "backdrop", "logo"],
  show: ["poster", "backdrop", "logo"],
  season: ["poster"],
  episode: ["thumb"],
} as const satisfies Record<ItemKind, readonly ArtworkType[]>;

/** A Show's Seasons, then its Episodes, in number order. */
async function showChildren(
  db: Database,
  showId: string,
): Promise<{ id: string; kind: ItemKind }[]> {
  const seasonRows = await db
    .select({ id: seasons.itemId })
    .from(seasons)
    .where(eq(seasons.showId, showId))
    .orderBy(seasons.seasonNumber);
  const episodeRows = await db
    .select({ id: episodes.itemId })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.itemId, episodes.seasonId))
    .where(eq(seasons.showId, showId))
    .orderBy(seasons.seasonNumber, episodes.episodeNumber);
  return [
    ...seasonRows.map(({ id }) => ({ id, kind: "season" as const })),
    ...episodeRows.map(({ id }) => ({ id, kind: "episode" as const })),
  ];
}

/** Registers the provider-fetch job handler; plugin metadata providers join the built-in ones when a runtime is given. */
export function registerMetadataJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
  request: typeof fetch = fetch,
  plugins?: Pick<PluginRuntime, "metadataProviders">,
): void {
  const markPending = (itemId: string) =>
    db
      .update(items)
      .set({ metadataState: "pending", updatedAt: new Date() })
      .where(eq(items.id, itemId));

  /** Matches one Item and stores its artwork; resolves whether it matched. */
  const fetchItem = async (
    item: { id: string; kind: ItemKind },
    providers: readonly MetadataProvider[],
    publish: () => Promise<unknown>,
    options: ProviderFetchOptions,
  ) => {
    const application = await applyMetadata(db, item.id, providers, {
      provider: options.provider,
    });
    await publish();
    if (application.state !== "matched") return false;
    await emitItemUpdated(db, item.id);
    await queueSubtitleFetch(db, item);
    try {
      await applyArtworkSelection(db, item.id, application.artwork, request, {
        preserveExisting: options.artworkPolicy === "keep",
        types:
          options.artworkPolicy === undefined
            ? storedArtwork[item.kind]
            : undefined,
      });
    } catch (error) {
      // Metadata already committed as matched; pending lets the next scan retry artwork after failed attempts.
      await markPending(item.id);
      await publish();
      throw error;
    }
    await publish();
    return true;
  };

  registry.register("provider-fetch", async (payload) => {
    const [item] = await db
      .select()
      .from(items)
      .where(eq(items.id, payload.itemId));
    // A deleted Show's weekly refresh has nothing left to do.
    if (!item && payload.weekly) return;
    if (!item) throw new AuthError("NOT_FOUND");
    const publish = () =>
      publishEvent(db, { kind: "library.changed", libraryId: item.libraryId });
    try {
      const providers = await metadataProviders(db, { request, plugins });
      const matched = await fetchItem(item, providers, publish, payload);
      if (!matched || item.kind !== "show") return;
      // One job covers the whole Show, so its Seasons and Episodes publish
      // one event at the end instead of one each.
      try {
        for (const child of await showChildren(db, item.id))
          await fetchItem(child, providers, async () => {}, payload);
      } catch (error) {
        // Pending lets the next scan retry the tree after this job gives up.
        await markPending(item.id);
        throw error;
      } finally {
        await publish();
      }
    } finally {
      // A failed fetch still keeps a continuing Show's weekly chain alive.
      if (item.kind === "show") await scheduleWeeklyRefresh(db, item.id);
    }
  });
}
