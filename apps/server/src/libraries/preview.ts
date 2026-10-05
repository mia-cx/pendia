import { lstat } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import type { libraries } from "../db/schema/index.ts";
import { groupMoviePaths } from "../mediums/movies.ts";
import { groupShowPaths } from "../mediums/shows.ts";
import { isVideoPath } from "../mediums/video-common/paths.ts";
import { scanScope } from "./scan.ts";
import { walkLibrary } from "./walker.ts";

/** A recognised Item a preview shows as an example. */
export type ScanPreviewExample =
  | {
      kind: "movie";
      title: string;
      year: number | null;
      folder: string;
      files: number;
    }
  | {
      kind: "show";
      title: string;
      year: number | null;
      folder: string;
      seasons: number[];
      episodes: number;
    };

/** What a scan of one folder would find. */
export type ScanPreview = {
  counts: { movie: number } | { show: number; season: number; episode: number };
  /** Video files that are neither recognised nor extras. */
  unrecognised: number;
  examples: ScanPreviewExample[];
  /** Why the preview found nothing, or null when it found something. */
  reason: "missing" | "not-a-folder" | "empty" | "unrecognised" | null;
};

/** The default number of recognised Items listed as examples. */
const DEFAULT_EXAMPLES = 5;

type Medium = (typeof libraries.$inferSelect)["medium"];

const zeroCounts = (medium: Medium): ScanPreview["counts"] =>
  medium === "movies" ? { movie: 0 } : { show: 0, season: 0, episode: 0 };

const nothingFound = (
  medium: Medium,
  reason: NonNullable<ScanPreview["reason"]>,
): ScanPreview => ({
  counts: zeroCounts(medium),
  unrecognised: 0,
  examples: [],
  reason,
});

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const byTitleThenFolder = (
  a: { title: string; folder: string },
  b: { title: string; folder: string },
) =>
  (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
  (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0);

const found = (items: number, unrecognised: number): ScanPreview["reason"] =>
  items > 0 ? null : unrecognised > 0 ? "unrecognised" : "empty";

/**
 * Reports what a scan of this absolute folder would find, as a root of its
 * own, without writing anything. Passing `signal` stops the walk as soon as
 * the caller aborts.
 */
export async function previewScan(
  folder: string,
  medium: Medium,
  options: { examples?: number; signal?: AbortSignal } = {},
): Promise<ScanPreview> {
  if (!isAbsolute(folder)) {
    throw new Error("Preview folder must be an absolute path.");
  }
  const { rules } = scanScope(medium);
  const stat = await lstat(folder).catch((error: unknown) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (stat === null) return nothingFound(medium, "missing");
  if (!stat.isDirectory()) return nothingFound(medium, "not-a-folder");

  const skipped: string[] = [];
  const rootName = posix.basename(folder);
  const walked: { rootId: string; rootName: string; path: string }[] = [];
  for await (const file of walkLibrary(folder, rules, {
    path: ".",
    recursive: true,
    onSkipped: (path) => {
      options.signal?.throwIfAborted();
      skipped.push(path);
    },
  })) {
    options.signal?.throwIfAborted();
    walked.push({ rootId: "preview", rootName, path: file.path });
  }
  const unrecognised = skipped.filter(
    (path) => isVideoPath(path) && !rules.isExtra(path),
  ).length;
  const limit = options.examples ?? DEFAULT_EXAMPLES;

  if (medium === "movies") {
    const groups = groupMoviePaths(walked);
    const examples: ScanPreviewExample[] = groups
      .map(
        (group): ScanPreviewExample => ({
          kind: "movie",
          title: group.title,
          year: group.year,
          folder: group.canonicalFolder,
          files: group.files.length,
        }),
      )
      .sort(byTitleThenFolder)
      .slice(0, limit);
    return {
      counts: { movie: groups.length },
      unrecognised,
      examples,
      reason: found(groups.length, unrecognised),
    };
  }

  const groups = groupShowPaths(walked);
  const episodeCount = (seasons: { episodes: unknown[] }[]) =>
    seasons.reduce((total, season) => total + season.episodes.length, 0);
  const examples: ScanPreviewExample[] = groups
    .map(
      (group): ScanPreviewExample => ({
        kind: "show",
        title: group.title,
        year: group.year,
        folder: group.canonicalFolder,
        seasons: group.seasons.map((season) => season.seasonNumber),
        episodes: episodeCount(group.seasons),
      }),
    )
    .sort(byTitleThenFolder)
    .slice(0, limit);
  return {
    counts: {
      show: groups.length,
      season: groups.reduce((total, group) => total + group.seasons.length, 0),
      episode: groups.reduce(
        (total, group) => total + episodeCount(group.seasons),
        0,
      ),
    },
    unrecognised,
    examples,
    reason: found(groups.length, unrecognised),
  };
}
