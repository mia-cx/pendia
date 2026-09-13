import type { MetadataProvider } from "@pendia/plugin-api";
import { eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { items } from "../db/schema/index.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { storeArtworkOriginal } from "./artwork-store.ts";
import { applyMetadata } from "./service.ts";
import { readMetadataSettings } from "./settings.ts";
import { createTmdbMetadataProvider } from "./tmdb.ts";

/** Registers the built-in provider-fetch job handler. */
export function registerMetadataJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
  request: typeof fetch = fetch,
): void {
  registry.register("provider-fetch", async (payload) => {
    const config = await readMetadataSettings(db);
    const providers: MetadataProvider[] = [];
    if (config.tmdb !== null)
      providers.push(createTmdbMetadataProvider(config.tmdb.apiKey, request));
    const application = await applyMetadata(db, payload.itemId, providers);
    if (application.state === "matched") {
      const poster = application.artwork.find(
        (candidate) => candidate.type === "poster",
      );
      if (poster)
        await storeArtworkOriginal(db, payload.itemId, poster, request);
    }
    const [item] = await db
      .select()
      .from(items)
      .where(eq(items.id, payload.itemId));
    if (!item) throw new AuthError("NOT_FOUND");
    await publishEvent(db, {
      kind: "library.changed",
      libraryId: item.libraryId,
    });
  });
}
