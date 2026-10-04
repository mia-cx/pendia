import type { MetadataProvider } from "@pendia/plugin-api";
import { and, eq, lte, sql } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { episodes, items, jobs, seasons, shows } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { readProviderKey } from "../providers/keys.ts";
import {
  removeSelectedArtwork,
  storeArtworkOriginal,
} from "./artwork-store.ts";
import { applyMetadata } from "./service.ts";
import { readMetadataSettings } from "./settings.ts";
import { createTmdbMetadataProvider } from "./tmdb.ts";
import { createTvdbMetadataProvider } from "./tvdb.ts";

/** Queues one Item's provider-fetch at `priority`, or returns the due one already queued, raised to it. */
export async function queueProviderFetch(
  db: Database,
  itemId: string,
  priority = 0,
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
      { type: "provider-fetch", itemId },
      { concurrencyKey, priority },
    );
  if (due.priority >= priority) return due;
  const [raised] = await db
    .update(jobs)
    .set({ priority })
    .where(and(eq(jobs.id, due.id), eq(jobs.state, "queued")))
    .returning();
  return raised ?? due;
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

async function metadataProviders(
  db: Database,
  request: typeof fetch,
): Promise<MetadataProvider[]> {
  const config = await readMetadataSettings(db);
  const providers: MetadataProvider[] = [];
  const storedTmdbKey = (await readProviderKey(db, "tmdb"))?.trim();
  const tmdbKey = storedTmdbKey || config.tmdb?.apiKey;
  if (tmdbKey !== undefined)
    providers.push(createTmdbMetadataProvider(tmdbKey, request));
  const tvdbKey = (await readProviderKey(db, "tvdb"))?.trim();
  if (tvdbKey)
    providers.push(
      createTvdbMetadataProvider(
        tvdbKey,
        await readProviderKey(db, "tvdb-pin"),
        request,
      ),
    );
  return providers;
}

/** A Show's Seasons, then its Episodes, in number order. */
async function showChildren(db: Database, showId: string) {
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
    ...seasonRows.map(({ id }) => ({ id, kind: "season" })),
    ...episodeRows.map(({ id }) => ({ id, kind: "episode" })),
  ];
}

/** Registers the built-in provider-fetch job handler. */
export function registerMetadataJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
  request: typeof fetch = fetch,
): void {
  const markPending = (itemId: string) =>
    db
      .update(items)
      .set({ metadataState: "pending", updatedAt: new Date() })
      .where(eq(items.id, itemId));

  /** Matches one Item and stores its primary artwork; resolves whether it matched. */
  const fetchItem = async (
    item: { id: string; kind: string },
    providers: readonly MetadataProvider[],
    publish: () => Promise<unknown>,
  ) => {
    const application = await applyMetadata(db, item.id, providers);
    await publish();
    if (application.state !== "matched") return false;
    const type = item.kind === "episode" ? "thumb" : "poster";
    const primary = application.artwork.find(
      (candidate) => candidate.type === type,
    );
    if (primary === undefined) {
      if (await removeSelectedArtwork(db, item.id, type)) await publish();
      return true;
    }
    try {
      await storeArtworkOriginal(db, item.id, primary, request);
    } catch (error) {
      // Metadata already committed as matched; pending lets the next scan
      // retry the artwork after this job's own attempts run out.
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
      const providers = await metadataProviders(db, request);
      const matched = await fetchItem(item, providers, publish);
      if (!matched || item.kind !== "show") return;
      // One job covers the whole Show, so its Seasons and Episodes publish
      // one event at the end instead of one each.
      try {
        for (const child of await showChildren(db, item.id))
          await fetchItem(child, providers, async () => {});
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
