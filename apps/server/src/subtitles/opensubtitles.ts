import { join } from "node:path";
import type { SubtitleMatch, SubtitleProvider } from "@pendia/plugin-api";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  episodes,
  files,
  items,
  libraries,
  providerIds,
  seasons,
  versions,
} from "../db/schema/index.ts";
import { readBoundedBytes } from "../metadata/bounded-body.ts";
import { jsonDecoders, requestJson } from "../metadata/provider-http.ts";
import { readLanguage, subtitleFormats } from "./store.ts";

const baseUrl = "https://api.opensubtitles.com/api/v1";
// OpenSubtitles asks every client to name itself.
const userAgent = "Pendia v1.0.0";
const limits = {
  label: "OpenSubtitles",
  timeoutMs: 15_000,
  maxResponseBytes: 4 * 1024 * 1024,
};
const maxSubtitleBytes = 8 * 1024 * 1024;
const hashChunkBytes = 64 * 1024;
// Pages read per language when earlier pages hold no full track.
const maxPages = 5;

const { asObject, invalid, requiredString } = jsonDecoders("OpenSubtitles");

/**
 * The OpenSubtitles hash of a file: its size plus the 64-bit little-endian
 * words of its first and last 64 KiB, modulo 2^64, as 16 hex digits.
 */
export async function openSubtitlesHash(path: string): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  const chunk = Math.min(hashChunkBytes, size);
  let sum = BigInt(size);
  for (const offset of [0, size - chunk]) {
    const bytes = await file.slice(offset, offset + chunk).bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let at = 0; at + 8 <= bytes.length; at += 8)
      sum += view.getBigUint64(at, true);
  }
  return BigInt.asUintN(64, sum).toString(16).padStart(16, "0");
}

/** The numeric part of an IMDb id, which is how OpenSubtitles takes it. */
function imdbNumber(id: string | undefined): string | undefined {
  return id?.replace(/^tt0*/i, "") || undefined;
}

async function itemIds(db: Database, itemId: string) {
  const rows = await db
    .select({ provider: providerIds.provider, value: providerIds.value })
    .from(providerIds)
    .where(eq(providerIds.itemId, itemId));
  return Object.fromEntries(rows.map((row) => [row.provider, row.value]));
}

/** The search parameters for one Item: hash and name, plus any provider ids. */
async function searchParameters(db: Database, itemId: string) {
  const [item] = await db
    .select({
      kind: items.kind,
      title: items.title,
      year: items.year,
      rootPath: libraries.rootPath,
    })
    .from(items)
    .innerJoin(libraries, eq(libraries.id, items.libraryId))
    .where(eq(items.id, itemId));
  if (item === undefined) throw new Error(`Item ${itemId} does not exist.`);
  const params: Record<string, string | undefined> = {};
  const [file] = await db
    .select({ path: files.path })
    .from(files)
    .innerJoin(versions, eq(versions.id, files.versionId))
    .where(
      and(
        eq(files.itemId, itemId),
        eq(versions.origin, "imported"),
        eq(versions.format, "video"),
      ),
    )
    .orderBy(asc(versions.id), asc(files.order))
    .limit(1);
  if (file !== undefined)
    params.moviehash = await openSubtitlesHash(join(item.rootPath, file.path));
  if (item.kind === "episode") {
    const [episode] = await db
      .select({
        showId: seasons.showId,
        seasonNumber: seasons.seasonNumber,
        episodeNumber: episodes.episodeNumber,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.itemId, episodes.seasonId))
      .where(eq(episodes.itemId, itemId));
    if (episode === undefined) throw new Error(`Episode ${itemId} is missing.`);
    const [show] = await db
      .select({ title: items.title })
      .from(items)
      .where(eq(items.id, episode.showId));
    const ids = await itemIds(db, episode.showId);
    Object.assign(params, {
      type: "episode",
      query: show?.title,
      season_number: String(episode.seasonNumber),
      episode_number: String(episode.episodeNumber),
      parent_imdb_id: imdbNumber(ids.imdb),
      parent_tmdb_id: ids.tmdb,
    });
  } else {
    const ids = await itemIds(db, itemId);
    Object.assign(params, {
      type: "movie",
      query: item.title,
      year: item.year?.toString(),
      imdb_id: imdbNumber(ids.imdb),
      tmdb_id: ids.tmdb,
    });
  }
  return params;
}

function readMatch(
  entry: unknown,
  languages: ReadonlySet<string>,
): SubtitleMatch | null {
  const attributes = asObject(asObject(entry).attributes);
  if (
    attributes.machine_translated === true ||
    attributes.ai_translated === true
  )
    return null;
  const language = readLanguage(requiredString(attributes.language));
  if (language === null || !languages.has(language)) return null;
  if (!Array.isArray(attributes.files)) return invalid();
  // A split release (CD1, CD2) holds part of the dialogue per file, so only
  // a single-file result is a whole track.
  const [only, ...rest] = attributes.files;
  if (only === undefined || rest.length > 0) return null;
  const fileId = asObject(only).file_id;
  if (typeof fileId !== "number" || !Number.isSafeInteger(fileId))
    return invalid();
  const downloads =
    typeof attributes.download_count === "number"
      ? attributes.download_count
      : 0;
  return {
    providerId: String(fileId),
    language,
    forced: attributes.foreign_parts_only === true,
    // A hash match is the same release; downloads break ties among the rest.
    score:
      (attributes.moviehash_match === true ? 0.9 : 0.6) +
      (0.1 * downloads) / (downloads + 1000),
  };
}

/**
 * OpenSubtitles on the subtitle provider contract. Search asks the REST API
 * by the Item's file hash, its name and its provider ids, per language;
 * download resolves a temporary link and reads the file.
 */
export function createOpenSubtitlesProvider(
  db: Database,
  apiKey: string,
  request: typeof fetch = fetch,
): SubtitleProvider {
  const headers = { "Api-Key": apiKey, "User-Agent": userAgent };
  return {
    id: "opensubtitles",
    async search({ itemId, languages }) {
      const wanted = new Set(
        languages.map(readLanguage).filter((language) => language !== null),
      );
      if (wanted.size === 0) return [];
      const params = await searchParameters(db, itemId);
      const matches: SubtitleMatch[] = [];
      // One search per language: results come in pages, and a popular
      // language would otherwise push the others off the first one.
      for (const language of wanted) {
        // A page can hold only split, translated or forced results, so later
        // pages are read until the language has a full track to offer.
        for (
          let page = 1, pages = 1;
          page <= Math.min(pages, maxPages);
          page++
        ) {
          const query = new URLSearchParams({ languages: language });
          for (const [key, value] of Object.entries(params))
            if (value !== undefined) query.set(key, value.toLowerCase());
          if (page > 1) query.set("page", String(page));
          // Sorted, lowercase parameters avoid a redirect to the canonical URL.
          query.sort();
          const body = asObject(
            await requestJson(
              request,
              new URL(`${baseUrl}/subtitles?${query}`),
              limits,
              { init: { headers } },
            ),
          );
          if (!Array.isArray(body.data)) return invalid();
          let full = false;
          for (const entry of body.data) {
            const match = readMatch(entry, wanted);
            if (match === null) continue;
            matches.push(match);
            full ||= !match.forced;
          }
          if (full) break;
          if (typeof body.total_pages === "number") pages = body.total_pages;
        }
      }
      return matches;
    },
    async download({ providerId }) {
      const fileId = Number(providerId);
      if (!Number.isSafeInteger(fileId) || fileId < 1)
        throw new Error(`${providerId} is not an OpenSubtitles file id.`);
      const answer = asObject(
        await requestJson(request, new URL(`${baseUrl}/download`), limits, {
          init: {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ file_id: fileId }),
          },
        }),
      );
      const link = requiredString(answer.link);
      const extension = requiredString(answer.file_name)
        .split(".")
        .at(-1)
        ?.toLowerCase()
        .replace(/^ssa$/, "ass");
      // The download is SubRip unless the file name says otherwise.
      const format =
        subtitleFormats.find((known) => known === extension) ?? "srt";
      const response = await request(link, {
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
      if (!response.ok || response.body === null)
        throw new Error(
          `OpenSubtitles download failed with status ${response.status}.`,
        );
      const bytes = await readBoundedBytes(
        response.body,
        maxSubtitleBytes,
        () => new Error("OpenSubtitles subtitle too large."),
      );
      return { format, text: new TextDecoder().decode(bytes) };
    },
  };
}
