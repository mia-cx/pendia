import type { MetadataProvider } from "@pendia/plugin-api";
import { and, eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { episodes, items, jobs, seasons } from "../db/schema/index.ts";
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

/** Queues one Item's provider-fetch, or returns the one already queued. */
export async function queueProviderFetch(db: Database, itemId: string) {
  const concurrencyKey = `provider:${itemId}`;
  // A running fetch never blocks: a pending Item after a provider change
  // earns one queued successor that replays the fetch.
  const [queued] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "provider-fetch"),
        eq(jobs.concurrencyKey, concurrencyKey),
        eq(jobs.state, "queued"),
      ),
    )
    .limit(1);
  return (
    queued ??
    createJobQueue(db).enqueue(
      { type: "provider-fetch", itemId },
      { concurrencyKey },
    )
  );
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
    if (!item) throw new AuthError("NOT_FOUND");
    const publish = () =>
      publishEvent(db, { kind: "library.changed", libraryId: item.libraryId });
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
  });
}
