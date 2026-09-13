import { posix } from "node:path";
import { movies as movieTable } from "../db/schema/movies.ts";
import type { Medium } from "./medium.ts";
import { isVideoExtra, isVideoPath } from "./video-common/paths.ts";

/** The movies medium: a leaf Item per canonical folder with one Version per file. */
export const moviesMedium = {
  id: "movies",
  kinds: [
    { kind: "movie", parent: null, table: movieTable, hasVersions: true },
  ],
  scan: { identify, parse, isExtra },
  providers: ["metadata", "subtitles", "artwork"],
  formats: ["video"],
  browse: {
    coreShelves: ["continue-watching", "recently-added"],
    shelves: [],
    screens: { movie: "/movies/:id" },
  },
  translation: { protocol: "jellyfin" },
} satisfies Medium;

const normalizeStem = (value: string) =>
  value.toLowerCase().replace(/[\s._-]+/g, "");

function isExtra(path: string): boolean {
  if (!isVideoExtra(path)) {
    return false;
  }
  const folder = posix.dirname(path);
  if (
    folder
      .split("/")
      .some(
        (part) =>
          part.toLowerCase() === "extras" ||
          part.toLowerCase().endsWith(".pendia"),
      )
  ) {
    return true;
  }
  const stem = posix.basename(path, posix.extname(path));
  const { title, year } = parse(folder);
  const matchesTitle = [
    title,
    year === null ? title : `${title} (${year})`,
  ].some((name) => normalizeStem(name) === normalizeStem(stem));
  return (
    isVideoExtra(`${posix.dirname(folder)}/placeholder.mkv`) || !matchesTitle
  );
}

function identify(
  path: string,
): { kind: string; canonicalFolder: string } | null {
  if (
    posix.isAbsolute(path) ||
    path.split("/").includes("..") ||
    !isVideoPath(path) ||
    isExtra(path)
  ) {
    return null;
  }
  const canonicalFolder = posix.dirname(path);
  if (canonicalFolder === "." || parse(canonicalFolder).title === "") {
    return null;
  }
  return { kind: "movie", canonicalFolder };
}

const providerSuffixSource = "\\{(tmdb|imdb|tvdb)[-=]([^}]*)\\}";

const providerValuePatterns: Record<string, RegExp> = {
  imdb: /^tt0*[1-9][0-9]*$/i,
  tmdb: /^[1-9][0-9]*$/,
  tvdb: /^[1-9][0-9]*$/,
};

function folderProviderIds(canonicalFolder: string): Record<string, string> {
  const ids: Record<string, string> = {};
  const pattern = new RegExp(providerSuffixSource, "gi");
  for (const match of posix.basename(canonicalFolder).matchAll(pattern)) {
    const provider = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (provider in ids || !providerValuePatterns[provider]?.test(value))
      continue;
    ids[provider] = provider === "imdb" ? value.toLowerCase() : value;
  }
  return ids;
}

function parse(canonicalFolder: string): {
  title: string;
  year: number | null;
} {
  const folder = posix
    .basename(canonicalFolder)
    .replace(new RegExp(`\\s*${providerSuffixSource}`, "gi"), "")
    .trim();
  const match = /^(.*?)\s*\((\d{4})\)(?:\s.*)?$/.exec(folder);
  const rawTitle = (match?.[1] ?? folder).trim();
  const title = rawTitle.includes(" ")
    ? rawTitle
    : rawTitle.replace(/[._]/g, " ");
  return { title, year: match?.[2] ? Number(match[2]) : null };
}

/** One canonical movie folder: parsed identity plus its accepted member paths. */
export interface MoviePathGroup {
  canonicalFolder: string;
  title: string;
  year: number | null;
  providerIds: Record<string, string>;
  paths: string[];
}

/** Group accepted library-relative paths by canonical folder, sorted and deduplicated. */
export function groupMoviePaths(paths: Iterable<string>): MoviePathGroup[] {
  const byFolder = new Map<string, Set<string>>();
  for (const path of paths) {
    const identified = identify(path);
    if (!identified) {
      continue;
    }
    let members = byFolder.get(identified.canonicalFolder);
    if (!members) {
      members = new Set();
      byFolder.set(identified.canonicalFolder, members);
    }
    members.add(path);
  }
  return [...byFolder.entries()]
    .map(([canonicalFolder, members]) => ({
      canonicalFolder,
      ...parse(canonicalFolder),
      providerIds: folderProviderIds(canonicalFolder),
      paths: [...members].sort(),
    }))
    .sort((a, b) => a.canonicalFolder.localeCompare(b.canonicalFolder));
}
