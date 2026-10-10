import type { SubtitleMatch, SubtitleProvider } from "@thalia/plugin-api";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { items, jobs } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { readMetadataSettings } from "../metadata/settings.ts";
import { PluginFailed, type PluginRuntime } from "../plugins/runtime.ts";
import { subtitleProviders } from "./providers.ts";
import {
  listSubtitles,
  readLanguage,
  subtitleFormats,
  writeSubtitle,
} from "./store.ts";

const subtitleKinds = new Set(["movie", "episode"]);

/** Queues a subtitle-fetch for a movie or episode when subtitle languages are configured, unless one is queued already. */
export async function queueSubtitleFetch(
  db: Database,
  item: { id: string; kind: string },
) {
  if (!subtitleKinds.has(item.kind)) return;
  const { subtitleLanguages } = await readMetadataSettings(db);
  if (subtitleLanguages.length === 0) return;
  const concurrencyKey = `subtitles:${item.id}`;
  const [queued] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "subtitle-fetch"),
        eq(jobs.concurrencyKey, concurrencyKey),
        eq(jobs.state, "queued"),
      ),
    )
    .limit(1);
  if (queued !== undefined) return;
  await createJobQueue(db).enqueue(
    { type: "subtitle-fetch", itemId: item.id },
    { concurrencyKey },
  );
}

/** Runs plugin code that may have failed the plugin; its failure is already logged, so it counts as no answer. */
async function unlessFailed<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PluginFailed) return null;
    throw error;
  }
}

/** Registers the subtitle-fetch job: every provider is asked for the missing languages, and the best full match per language is stored. */
export function registerSubtitleJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
  request: typeof fetch = fetch,
  plugins?: Pick<PluginRuntime, "subtitleProviders">,
): void {
  registry.register("subtitle-fetch", async ({ itemId }) => {
    const [item] = await db
      .select({ kind: items.kind })
      .from(items)
      .where(eq(items.id, itemId));
    // A deleted Item has nothing left to fetch.
    if (item === undefined || !subtitleKinds.has(item.kind)) return;
    const { subtitleLanguages } = await readMetadataSettings(db);
    const stored = new Set(
      (await listSubtitles(db, itemId))
        .filter((track) => !track.forced)
        .map((track) => track.language),
    );
    const missing = subtitleLanguages.filter(
      (language) => !stored.has(language),
    );
    if (missing.length === 0) return;

    const best = new Map<
      string,
      { provider: SubtitleProvider; match: SubtitleMatch }
    >();
    for (const provider of await subtitleProviders(db, { request, plugins })) {
      const matches = await unlessFailed(() =>
        provider.search({ itemId, languages: missing }),
      );
      for (const match of matches ?? []) {
        const language = readLanguage(match.language);
        // A forced track only covers foreign dialogue; it is not a full track.
        if (language === null || !missing.includes(language) || match.forced)
          continue;
        const current = best.get(language);
        if (current === undefined || match.score > current.match.score)
          best.set(language, { provider, match });
      }
    }

    for (const [language, { provider, match }] of best) {
      const downloaded = await unlessFailed(() =>
        provider.download({ providerId: match.providerId }),
      );
      if (downloaded === null) continue;
      const format = subtitleFormats.find(
        (known) => known === downloaded.format,
      );
      if (format === undefined || typeof downloaded.text !== "string")
        throw new Error(`${provider.id} returned an unknown subtitle format.`);
      await writeSubtitle(db, itemId, { language, format }, downloaded.text);
    }
  });
}
