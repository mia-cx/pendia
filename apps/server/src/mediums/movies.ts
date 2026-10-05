import { posix } from "node:path";
import { movies as movieTable } from "../db/schema/movies.ts";
import type { Medium, RootedName } from "./medium.ts";
import { isVideoExtra, isVideoPath } from "./video-common/paths.ts";
import { folderProviderIds } from "./video-common/provider-ids.ts";
import {
  namesOneTitle,
  parseRelease,
  parseTitle,
  sameTitle,
  titleKey,
} from "./video-common/titles.ts";

/** The movies medium: a leaf Item per canonical folder with one Version per file. */
export const moviesMedium = {
  id: "movies",
  kinds: [
    { kind: "movie", parent: null, table: movieTable, hasVersions: true },
  ],
  scan: { identify, parse, isExtra, itemFolder },
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

const partFolderPattern = /^(?:disc|disk|dvd|cd|part|pt)[\s._-]*\d{1,2}$/i;

/** The Item folder a file in this directory belongs to, or ".". */
function itemFolder(directory: string): string {
  const parts = directory.split("/");
  let end = parts.length;
  while (end > 0 && partFolderPattern.test(parts[end - 1] ?? "")) {
    end -= 1;
  }
  return end === 0 ? "." : parts.slice(0, end).join("/");
}

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

interface AcceptedPath {
  canonicalFolder: string;
  titleKey: string;
  title: string;
  year: number | null;
  providerIds: Record<string, string>;
}

function analyze(rootName: string, path: string): AcceptedPath | null {
  if (
    posix.isAbsolute(path) ||
    path.split("/").includes("..") ||
    !isVideoPath(path) ||
    isExtra(path)
  ) {
    return null;
  }
  const anchor = itemFolder(posix.dirname(path));
  const folderName = anchor === "." ? rootName : posix.basename(anchor);
  const stem = posix.basename(path, posix.extname(path));
  const fileTitle = parseRelease(stem);
  const folderTitle = parseTitle(folderName);
  let title: string;
  let year: number | null;
  let key: string;
  let providerIds: Record<string, string>;
  if (
    namesOneTitle(folderName) ||
    fileTitle.title === "" ||
    sameTitle(fileTitle.title, folderTitle.title)
  ) {
    title = folderTitle.title;
    year = folderTitle.year;
    key = anchor === "." ? titleKey(title, year) : "";
    providerIds = folderProviderIds(folderName);
  } else {
    title = fileTitle.title;
    year = fileTitle.year;
    key = titleKey(title, year);
    providerIds = folderProviderIds(stem);
  }
  if (title === "") {
    return null;
  }
  return { canonicalFolder: anchor, titleKey: key, title, year, providerIds };
}

function identify(
  path: string,
): { kind: string; canonicalFolder: string } | null {
  const accepted = analyze("library", path);
  if (accepted === null) {
    return null;
  }
  return { kind: "movie", canonicalFolder: accepted.canonicalFolder };
}

function parse(canonicalFolder: string): {
  title: string;
  year: number | null;
} {
  return parseTitle(posix.basename(canonicalFolder));
}

/** One canonical movie: its Item folder, title key and accepted files per root. */
export interface MoviePathGroup {
  canonicalFolder: string;
  titleKey: string;
  title: string;
  year: number | null;
  providerIds: Record<string, string>;
  files: { rootId: string; path: string }[];
}

/** Group walked files into canonical Movies by Item folder and title key. */
export function groupMoviePaths(files: Iterable<RootedName>): MoviePathGroup[] {
  const groups = new Map<string, MoviePathGroup>();
  const rootOrder: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!rootOrder.includes(file.rootId)) rootOrder.push(file.rootId);
    const key = `${file.rootId}:${file.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const accepted = analyze(file.rootName, file.path);
    if (accepted === null) {
      continue;
    }
    const groupKey = `${accepted.canonicalFolder}\u0000${accepted.titleKey}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { ...accepted, files: [] };
      groups.set(groupKey, group);
    }
    group.files.push({ rootId: file.rootId, path: file.path });
  }
  const rootRank = (rootId: string) => {
    const rank = rootOrder.indexOf(rootId);
    return rank === -1 ? rootOrder.length : rank;
  };
  return [...groups.values()]
    .map((group) => ({
      ...group,
      files: group.files.sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          rootRank(a.rootId) - rootRank(b.rootId),
      ),
    }))
    .sort(
      (a, b) =>
        a.canonicalFolder.localeCompare(b.canonicalFolder) ||
        a.titleKey.localeCompare(b.titleKey),
    );
}
