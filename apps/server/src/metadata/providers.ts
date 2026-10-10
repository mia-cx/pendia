import type { MetadataProvider } from "@thalia/plugin-api";
import type { Database } from "../db/client.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import { readProviderKey } from "../providers/keys.ts";
import { readMetadataSettings } from "./settings.ts";
import { createTmdbMetadataProvider } from "./tmdb.ts";
import { createTvdbMetadataProvider } from "./tvdb.ts";

/** Provider dependencies shared by background jobs and interactive metadata lookup. */
export type MetadataProviderOptions = {
  request?: typeof fetch;
  plugins?: Pick<PluginRuntime, "metadataProviders">;
};

/** Loads credentialed built-in and plugin providers; credentials stay inside their instances. */
export async function metadataProviders(
  db: Database,
  { request = fetch, plugins }: MetadataProviderOptions = {},
): Promise<MetadataProvider[]> {
  const config = await readMetadataSettings(db);
  const providers: MetadataProvider[] = [];
  const storedTmdbKey = (await readProviderKey(db, "tmdb"))?.trim();
  // An admin-stored key wins; TMDB_API_KEY covers deployments set up by env.
  const tmdbKey =
    storedTmdbKey || config.tmdb?.apiKey || Bun.env.TMDB_API_KEY?.trim();
  if (tmdbKey) providers.push(createTmdbMetadataProvider(tmdbKey, request));
  const tvdbKey = (await readProviderKey(db, "tvdb"))?.trim();
  if (tvdbKey)
    providers.push(
      createTvdbMetadataProvider(
        tvdbKey,
        await readProviderKey(db, "tvdb-pin"),
        request,
      ),
    );
  if (plugins !== undefined)
    providers.push(...(await plugins.metadataProviders()));
  return providers;
}
