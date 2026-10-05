import { posix } from "node:path";
import { viewableLibraryIds } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  episodes as episodeTable,
  seasons as seasonTable,
  shows as showTable,
} from "../db/schema/shows.ts";
import type { Medium, RootedName, ScanRules } from "./medium.ts";
import { isVideoExtra, isVideoPath } from "./video-common/paths.ts";
import { folderProviderIds } from "./video-common/provider-ids.ts";
import {
  namesOneTitle,
  parseRelease,
  parseTitle,
  sameTitle,
  titleKey,
} from "./video-common/titles.ts";

/** Sonarr-style path rules shared by show walks and the shows medium. */
export const showsScan = {
  identify,
  parse,
  isExtra,
  itemFolder,
} satisfies ScanRules;

/** Create the shows medium with its database-backed next up shelf. */
export function createShowsMedium(db: Database): Medium {
  return {
    id: "shows",
    kinds: [
      { kind: "show", parent: null, table: showTable, hasVersions: false },
      {
        kind: "season",
        parent: "show",
        table: seasonTable,
        hasVersions: false,
      },
      {
        kind: "episode",
        parent: "season",
        table: episodeTable,
        hasVersions: true,
      },
    ],
    scan: showsScan,
    providers: ["metadata", "subtitles", "artwork"],
    formats: ["video"],
    browse: {
      coreShelves: ["continue-watching", "recently-added"],
      shelves: [
        {
          id: "next-up",
          title: "Next up",
          items: ({ userId }) => nextUp(db, userId),
        },
      ],
      screens: {
        show: "/shows/:id",
        season: "/shows/:showId/seasons/:id",
        episode: "/shows/:showId/seasons/:seasonId/episodes/:id",
      },
    },
    translation: { protocol: "jellyfin" },
  };
}

/** Return the first unwatched Episode after each user's last completed Episode per Show. */
export async function nextUp(db: Database, userId: string): Promise<string[]> {
  const viewable = new Set(await viewableLibraryIds(db, userId));
  if (viewable.size === 0) return [];
  const rows = await db.$client<{ id: string; libraryId: string }[]>`
    with last_watched as (
      select distinct on (season.show_id)
        season.show_id,
        season.season_number,
        episode.episode_number,
        mark.played_at
      from progress as mark
      inner join episodes as episode on episode.item_id = mark.item_id
      inner join seasons as season on season.item_id = episode.season_id
      where mark.user_id = ${userId}
        and mark.completed
      order by
        season.show_id,
        season.season_number desc,
        episode.episode_number desc
    )
    select candidate.id, candidate.library_id as "libraryId"
    from last_watched
    cross join lateral (
      select episode_item.id, episode_item.library_id
      from seasons as candidate_season
      inner join episodes as candidate_episode
        on candidate_episode.season_id = candidate_season.item_id
      inner join items as episode_item
        on episode_item.id = candidate_episode.item_id
      left join progress as candidate_mark
        on candidate_mark.item_id = episode_item.id
        and candidate_mark.user_id = ${userId}
      where candidate_season.show_id = last_watched.show_id
        and (
          candidate_season.season_number,
          candidate_episode.episode_number
        ) > (
          last_watched.season_number,
          last_watched.episode_number
        )
        and not coalesce(candidate_mark.completed, false)
      order by
        candidate_season.season_number,
        candidate_episode.episode_number,
        episode_item.id
      limit 1
    ) as candidate
    order by
      last_watched.played_at desc nulls last,
      last_watched.show_id,
      candidate.id
  `;
  return rows.filter((row) => viewable.has(row.libraryId)).map((row) => row.id);
}

const seasonFolderPattern = /^(?:season|series)[\s._-]*(\d{1,4})$/i;
const shortSeasonFolderPattern = /^s(\d{1,4})$/i;
const specialsFolderPattern = /^specials$/i;
const discFolderPattern = /^(?:disc|disk|dvd|cd)[\s._-]*\d{1,2}$/i;
const splitMarkerPattern = /^(.*?)[\s._-]+(?:part|pt|cd)[\s._-]*(\d+)$/i;

const tokenBefore = "(?:^|[\\s._-])";
const tokenAfter = "(?=$|[\\s._-])";
const fullTokenPattern = new RegExp(
  `${tokenBefore}s(\\d{1,2})[\\s._]?e(\\d{1,3})(?:-e?(\\d{1,3})|e(\\d{1,3}))?${tokenAfter}`,
  "i",
);
const crossTokenPattern = new RegExp(
  `${tokenBefore}(\\d{1,2})x(\\d{2,3})(?:-(\\d{2,3}))?${tokenAfter}`,
  "i",
);
const episodeOnlyPattern = new RegExp(
  `${tokenBefore}(?:e|ep|episode)[\\s._-]*(\\d{1,3})${tokenAfter}`,
  "i",
);

function seasonNumber(folder: string): number | null {
  if (specialsFolderPattern.test(folder)) {
    return 0;
  }
  const match =
    seasonFolderPattern.exec(folder) ?? shortSeasonFolderPattern.exec(folder);
  return match?.[1] === undefined ? null : Number(match[1]);
}

interface EpisodeToken {
  season: number | null;
  start: number;
  end: number | null;
  index: number;
}

/** The first full or cross episode token in a stem, or null; descending ranges count as none. */
function episodeFolderToken(stem: string): EpisodeToken | null {
  const full = fullTokenPattern.exec(stem);
  if (full?.[1] !== undefined && full[2] !== undefined) {
    const end = full[3] ?? full[4];
    const start = Number(full[2]);
    const endNumber = end === undefined ? null : Number(end);
    if (endNumber !== null && endNumber < start) {
      return null;
    }
    return {
      season: Number(full[1]),
      start,
      end: endNumber,
      index: full.index,
    };
  }
  const cross = crossTokenPattern.exec(stem);
  if (cross?.[1] !== undefined && cross[2] !== undefined) {
    const start = Number(cross[2]);
    const end = cross[3] === undefined ? null : Number(cross[3]);
    if (end !== null && end < start) {
      return null;
    }
    return { season: Number(cross[1]), start, end, index: cross.index };
  }
  return null;
}

/** The first episode token in a stem, or null; descending ranges count as none. */
function episodeToken(stem: string): EpisodeToken | null {
  if (fullTokenPattern.test(stem) || crossTokenPattern.test(stem)) {
    return episodeFolderToken(stem);
  }
  const only = episodeOnlyPattern.exec(stem);
  if (only?.[1] !== undefined) {
    return {
      season: null,
      start: Number(only[1]),
      end: null,
      index: only.index,
    };
  }
  return null;
}

/** Whether a folder name is structural: a season, disc or episode folder. */
function isStructuralFolder(name: string): boolean {
  return (
    seasonNumber(name) !== null ||
    discFolderPattern.test(name) ||
    episodeFolderToken(name) !== null
  );
}

/** The Item folder a file in this directory belongs to, or ".". */
function itemFolder(directory: string): string {
  const parts = directory.split("/");
  let end = parts.length;
  while (end > 0 && isStructuralFolder(parts[end - 1] ?? "")) {
    end -= 1;
  }
  return end === 0 ? "." : parts.slice(0, end).join("/");
}

interface AcceptedPath {
  canonicalFolder: string;
  titleKey: string;
  title: string;
  year: number | null;
  providerIds: Record<string, string>;
  seasonFolder: string | null;
  seasonNumber: number;
  episodeNumber: number;
  episodeEndNumber: number | null;
  versionKey: string;
  part: number | null;
}

function analyze(rootName: string, path: string): AcceptedPath | null {
  const parts = path.split("/");
  if (
    posix.isAbsolute(path) ||
    parts.includes("..") ||
    !isVideoPath(path) ||
    isExtra(path)
  ) {
    return null;
  }
  const directory = posix.dirname(path);
  const anchor = itemFolder(directory);
  const stem = posix.basename(path, posix.extname(path));
  const split = splitMarkerPattern.exec(stem);
  const versionStem = split?.[1] ?? stem;
  const part = split?.[2] === undefined ? null : Number(split[2]);
  if (
    split !== null &&
    isExtra(posix.join(directory, `${versionStem}${posix.extname(path)}`))
  ) {
    return null;
  }
  const token = episodeToken(versionStem);
  if (token === null) {
    return null;
  }

  const between =
    anchor === "."
      ? directory === "."
        ? []
        : directory.split("/")
      : directory === anchor
        ? []
        : directory.slice(anchor.length + 1).split("/");
  let seasonFolder: string | null = null;
  for (const [index, folderPart] of between.entries()) {
    if (seasonNumber(folderPart) === null) continue;
    const relative = between.slice(0, index + 1).join("/");
    seasonFolder = anchor === "." ? relative : `${anchor}/${relative}`;
  }
  const loose = seasonFolder === null;
  const folderName = anchor === "." ? rootName : posix.basename(anchor);
  const folderTitle = parseTitle(folderName);
  const prefix = versionStem.slice(0, token.index).replace(/[\s._-]+$/, "");
  const prefixTitle = loose ? parseRelease(prefix) : null;

  let title: string;
  let year: number | null;
  let key: string;
  let providerIds: Record<string, string>;
  if (
    prefixTitle !== null &&
    prefixTitle.title !== "" &&
    !namesOneTitle(folderName) &&
    !sameTitle(prefixTitle.title, folderTitle.title)
  ) {
    title = prefixTitle.title;
    year = prefixTitle.year;
    key = titleKey(title, year);
    providerIds = folderProviderIds(stem);
  } else {
    title = folderTitle.title;
    year = folderTitle.year;
    key = anchor === "." ? titleKey(title, year) : "";
    providerIds = folderProviderIds(folderName);
  }
  if (title === "") {
    return null;
  }
  return {
    canonicalFolder: anchor,
    titleKey: key,
    title,
    year,
    providerIds,
    seasonFolder,
    seasonNumber:
      token.season ??
      (seasonFolder === null
        ? null
        : seasonNumber(posix.basename(seasonFolder))) ??
      1,
    episodeNumber: token.start,
    episodeEndNumber: token.end,
    versionKey:
      part === null ? `file:${path}` : `stem:${directory}:${versionStem}`,
    part,
  };
}

function isExtra(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((part) => part.toLowerCase().endsWith(".pendia"))) {
    return true;
  }
  if (parts[0]?.toLowerCase() === "extras") {
    return true;
  }
  return isVideoExtra(parts.slice(1).join("/"));
}

function identify(
  path: string,
): { kind: string; canonicalFolder: string } | null {
  const accepted = analyze("library", path);
  if (accepted === null) {
    return null;
  }
  return { kind: "episode", canonicalFolder: accepted.canonicalFolder };
}

function parse(canonicalFolder: string): {
  title: string;
  year: number | null;
} {
  return parseTitle(posix.basename(canonicalFolder));
}

/** One grouped Version of an Episode: its root and split Files in playback order. */
export interface ShowVersionPathGroup {
  rootId: string;
  paths: string[];
}

/** One Episode parsed from accepted paths. */
export interface EpisodePathGroup<
  V extends ShowVersionPathGroup = ShowVersionPathGroup,
> {
  episodeNumber: number;
  episodeEndNumber: number | null;
  title: string;
  versions: V[];
}

/** One Season under a canonical Show folder. */
export interface SeasonPathGroup {
  canonicalFolder: string;
  seasonNumber: number;
  title: string;
  episodes: EpisodePathGroup[];
}

/** One canonical Show: its Item folder, title key and accepted Seasons and Episodes. */
export interface ShowPathGroup {
  canonicalFolder: string;
  titleKey: string;
  title: string;
  year: number | null;
  providerIds: Record<string, string>;
  seasons: SeasonPathGroup[];
}

const episodeTitle = (start: number, end: number | null) =>
  end === null ? `Episode ${start}` : `Episodes ${start}-${end}`;

/**
 * Merges one Season's overlapping Episode ranges into single Episodes that
 * hold every Version. A Version stays at the start of the Episode that
 * already owns its Files, and no range reaches the next persisted start.
 */
export function mergeEpisodeRanges<V extends ShowVersionPathGroup>(
  discovered: readonly EpisodePathGroup<V>[],
  persistedStarts: readonly number[],
  ownerStarts: ReadonlyMap<string, number>,
): EpisodePathGroup<V>[] {
  const limit = (start: number) =>
    Math.min(...persistedStarts.filter((persisted) => persisted > start)) - 1;
  const entries = discovered
    .flatMap((episode) =>
      episode.versions.map((version) => {
        const start =
          version.paths
            .map((path) => ownerStarts.get(path))
            .find((owner) => owner !== undefined) ?? episode.episodeNumber;
        const end = episode.episodeEndNumber ?? episode.episodeNumber;
        return { start, end: Math.max(start, end), version };
      }),
    )
    .sort(
      (a, b) =>
        a.start - b.start ||
        (a.version.paths[0] ?? "").localeCompare(b.version.paths[0] ?? ""),
    );
  const merged: { start: number; end: number; versions: V[] }[] = [];
  for (const { start, end, version } of entries) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, Math.min(end, limit(last.start)));
      last.versions.push(version);
    } else {
      merged.push({
        start,
        end: Math.min(end, limit(start)),
        versions: [version],
      });
    }
  }
  return merged.map(({ start, end, versions }) => {
    const endNumber = end === start ? null : end;
    return {
      episodeNumber: start,
      episodeEndNumber: endNumber,
      title: episodeTitle(start, endNumber),
      versions,
    };
  });
}

/** Group walked files into canonical Shows by Item folder and title key. */
export function groupShowPaths(files: Iterable<RootedName>): ShowPathGroup[] {
  interface VersionFile {
    rootId: string;
    part: number | null;
    path: string;
  }
  const groups = new Map<
    string,
    {
      canonicalFolder: string;
      titleKey: string;
      title: string;
      year: number | null;
      providerIds: Record<string, string>;
      seasons: Map<
        number,
        {
          seasonFolder: string | null;
          seasonNumber: number;
          episodes: Map<
            number,
            {
              end: number | null;
              versions: Map<string, VersionFile[]>;
            }
          >;
        }
      >;
    }
  >();
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
      group = {
        canonicalFolder: accepted.canonicalFolder,
        titleKey: accepted.titleKey,
        title: accepted.title,
        year: accepted.year,
        providerIds: accepted.providerIds,
        seasons: new Map(),
      };
      groups.set(groupKey, group);
    }
    let season = group.seasons.get(accepted.seasonNumber);
    if (!season) {
      season = {
        seasonFolder: accepted.seasonFolder,
        seasonNumber: accepted.seasonNumber,
        episodes: new Map(),
      };
      group.seasons.set(accepted.seasonNumber, season);
    } else if (
      accepted.seasonFolder !== null &&
      (season.seasonFolder === null ||
        accepted.seasonFolder.localeCompare(season.seasonFolder) < 0)
    ) {
      season.seasonFolder = accepted.seasonFolder;
    }
    let episode = season.episodes.get(accepted.episodeNumber);
    if (!episode) {
      episode = { end: accepted.episodeEndNumber, versions: new Map() };
      season.episodes.set(accepted.episodeNumber, episode);
    } else if (accepted.episodeEndNumber !== null) {
      episode.end = Math.max(
        episode.end ?? accepted.episodeNumber,
        accepted.episodeEndNumber,
      );
    }
    const versionKey = `${file.rootId}:${accepted.versionKey}`;
    let version = episode.versions.get(versionKey);
    if (!version) {
      version = [];
      episode.versions.set(versionKey, version);
    }
    version.push({ rootId: file.rootId, part: accepted.part, path: file.path });
  }
  const rootRank = (rootId: string) => {
    const rank = rootOrder.indexOf(rootId);
    return rank === -1 ? rootOrder.length : rank;
  };
  return [...groups.values()]
    .map((group) => ({
      canonicalFolder: group.canonicalFolder,
      titleKey: group.titleKey,
      title: group.title,
      year: group.year,
      providerIds: group.providerIds,
      seasons: [...group.seasons.values()]
        .map((season) => ({
          canonicalFolder: season.seasonFolder ?? group.canonicalFolder,
          seasonNumber: season.seasonNumber,
          title:
            season.seasonNumber === 0
              ? "Specials"
              : `Season ${season.seasonNumber}`,
          episodes: [...season.episodes.entries()]
            .map(([episodeNumber, episode]) => ({
              episodeNumber,
              episodeEndNumber: episode.end,
              title: episodeTitle(episodeNumber, episode.end),
              versions: [...episode.versions.values()]
                .map(
                  (versionFiles): ShowVersionPathGroup => ({
                    rootId: versionFiles[0]?.rootId ?? "",
                    paths: versionFiles
                      .sort(
                        (a, b) =>
                          (a.part ?? 0) - (b.part ?? 0) ||
                          a.path.localeCompare(b.path),
                      )
                      .map((entry) => entry.path),
                  }),
                )
                .sort(
                  (a, b) =>
                    (a.paths[0] ?? "").localeCompare(b.paths[0] ?? "") ||
                    rootRank(a.rootId) - rootRank(b.rootId),
                ),
            }))
            .sort(
              (a, b) =>
                a.episodeNumber - b.episodeNumber ||
                (a.episodeEndNumber ?? a.episodeNumber) -
                  (b.episodeEndNumber ?? b.episodeNumber),
            ),
        }))
        .sort(
          (a, b) =>
            a.seasonNumber - b.seasonNumber ||
            a.canonicalFolder.localeCompare(b.canonicalFolder),
        ),
    }))
    .sort(
      (a, b) =>
        a.canonicalFolder.localeCompare(b.canonicalFolder) ||
        a.titleKey.localeCompare(b.titleKey),
    );
}
