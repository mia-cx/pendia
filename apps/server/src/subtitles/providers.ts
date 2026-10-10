import type { SubtitleProvider } from "@thalia/plugin-api";
import type { Database } from "../db/client.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import { readProviderKey } from "../providers/keys.ts";
import { createOpenSubtitlesProvider } from "./opensubtitles.ts";

/** Provider dependencies shared by subtitle jobs and interactive searches. */
export type SubtitleProviderOptions = {
  request?: typeof fetch;
  plugins?: Pick<PluginRuntime, "subtitleProviders">;
};

/** Loads configured subtitle providers without exposing their credentials. */
export async function subtitleProviders(
  db: Database,
  { request = fetch, plugins }: SubtitleProviderOptions = {},
): Promise<SubtitleProvider[]> {
  const providers: SubtitleProvider[] = [];
  const key = (await readProviderKey(db, "opensubtitles"))?.trim();
  if (key) providers.push(createOpenSubtitlesProvider(db, key, request));
  if (plugins !== undefined)
    providers.push(...(await plugins.subtitleProviders()));
  return providers;
}
