import { posix } from "node:path";

// Radarr and Sonarr write {tmdb-348}; Jellyfin writes [tmdbid-348] and Emby [tmdb-348].
const providerTagSource =
  "\\{(tmdb|imdb|tvdb)[-=]([^}]*)\\}|\\[(tmdb|imdb|tvdb)(?:id)?-([^\\]]*)\\]";

const providerValuePatterns: Record<string, RegExp> = {
  imdb: /^tt0*[1-9][0-9]*$/i,
  tmdb: /^[1-9][0-9]*$/,
  tvdb: /^[1-9][0-9]*$/,
};

/** Reads the valid provider id tags from a canonical folder's name; the first tag per provider wins. */
export function folderProviderIds(
  canonicalFolder: string,
): Record<string, string> {
  const ids: Record<string, string> = {};
  const pattern = new RegExp(providerTagSource, "gi");
  for (const match of posix.basename(canonicalFolder).matchAll(pattern)) {
    const provider = (match[1] ?? match[3] ?? "").toLowerCase();
    const value = (match[2] ?? match[4] ?? "").trim();
    if (provider in ids || !providerValuePatterns[provider]?.test(value))
      continue;
    ids[provider] = provider === "imdb" ? value.toLowerCase() : value;
  }
  return ids;
}

/** Removes provider id tags from a folder name. */
export function stripProviderTags(folder: string): string {
  return folder
    .replace(new RegExp(`\\s*(?:${providerTagSource})`, "gi"), "")
    .trim();
}
