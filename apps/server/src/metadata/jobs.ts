import type { MetadataProvider } from "@pendia/plugin-api";
import { eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { items } from "../db/schema/index.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { emitPluginEvents } from "../plugins/events.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import { readProviderKey } from "../providers/keys.ts";
import {
  removeSelectedArtwork,
  storeArtworkOriginal,
} from "./artwork-store.ts";
import { applyMetadata } from "./service.ts";
import { readMetadataSettings } from "./settings.ts";
import { createTmdbMetadataProvider } from "./tmdb.ts";

async function publishLibraryChanged(db: Database, itemId: string) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (!item) throw new AuthError("NOT_FOUND");
  await publishEvent(db, {
    kind: "library.changed",
    libraryId: item.libraryId,
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

/** Registers the provider-fetch job handler; plugin metadata providers join TMDB when a runtime is given. */
export function registerMetadataJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
  request: typeof fetch = fetch,
  plugins?: PluginRuntime,
): void {
  registry.register("provider-fetch", async (payload) => {
    const config = await readMetadataSettings(db);
    const providers: MetadataProvider[] = [];
    const storedTmdbKey = (await readProviderKey(db, "tmdb"))?.trim();
    const tmdbKey = storedTmdbKey || config.tmdb?.apiKey;
    if (tmdbKey !== undefined)
      providers.push(createTmdbMetadataProvider(tmdbKey, request));
    if (plugins !== undefined)
      providers.push(...(await plugins.metadataProviders()));
    const application = await applyMetadata(db, payload.itemId, providers);
    await publishLibraryChanged(db, payload.itemId);
    if (application.state !== "matched") return;
    await emitItemUpdated(db, payload.itemId);
    const poster = application.artwork.find(
      (candidate) => candidate.type === "poster",
    );
    if (poster === undefined) {
      const removed = await removeSelectedArtwork(db, payload.itemId, "poster");
      if (removed) await publishLibraryChanged(db, payload.itemId);
      return;
    }
    try {
      await storeArtworkOriginal(db, payload.itemId, poster, request);
    } catch (error) {
      // Metadata already committed as matched; pending lets the next scan
      // retry the poster after this job's own attempts run out.
      await db
        .update(items)
        .set({ metadataState: "pending", updatedAt: new Date() })
        .where(eq(items.id, payload.itemId));
      await publishLibraryChanged(db, payload.itemId);
      throw error;
    }
    await publishLibraryChanged(db, payload.itemId);
  });
}
