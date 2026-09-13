import { posix } from "node:path";
import { viewableLibraryIds } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  episodes as episodeTable,
  seasons as seasonTable,
  shows as showTable,
} from "../db/schema/shows.ts";
import type { Medium, ScanRules } from "./medium.ts";
import { isVideoExtra, isVideoPath } from "./video-common/paths.ts";

/** Sonarr-style path rules shared by show walks and the shows medium. */
export const showsScan = { identify, parse, isExtra } satisfies ScanRules;

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

const seasonFolderPattern = /^season[\s._-]*(\d+)$/i;
const episodeTokenPattern =
  /(?:^|[\s._-])s(\d{1,2})e(\d{1,3})(?:-e?(\d{1,3})|e(\d{1,3}))?(?=$|[\s._-])/i;
const splitMarkerPattern = /^(.*?)[\s._-]+(?:part|pt|cd)[\s._-]*(\d+)$/i;

function seasonNumber(folder: string): number | null {
  if (folder.toLowerCase() === "specials") {
    return 0;
  }
  const match = seasonFolderPattern.exec(folder);
  return match?.[1] === undefined ? null : Number(match[1]);
}

interface EpisodeNumbers {
  season: number;
  start: number;
  end: number | null;
}

function episodeNumbers(stem: string): EpisodeNumbers | null {
  const match = episodeTokenPattern.exec(stem);
  const end = match?.[3] ?? match?.[4];
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const start = Number(match[2]);
  const endNumber = end === undefined ? null : Number(end);
  if (endNumber !== null && endNumber < start) {
    return null;
  }
  return { season: Number(match[1]), start, end: endNumber };
}

interface AcceptedPath {
  canonicalFolder: string;
  seasonFolder: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeEndNumber: number | null;
  versionKey: string;
  part: number | null;
}

function analyze(path: string): AcceptedPath | null {
  const parts = path.split("/");
  if (
    posix.isAbsolute(path) ||
    parts.includes("..") ||
    parts.length !== 3 ||
    !isVideoPath(path) ||
    isExtra(path)
  ) {
    return null;
  }
  const [canonicalFolder, seasonFolder, name] = parts;
  if (
    canonicalFolder === undefined ||
    seasonFolder === undefined ||
    name === undefined
  ) {
    return null;
  }
  const season = seasonNumber(seasonFolder);
  if (
    season === null ||
    canonicalFolder === "." ||
    parse(canonicalFolder).title === ""
  ) {
    return null;
  }
  const stem = posix.basename(name, posix.extname(name));
  const split = splitMarkerPattern.exec(stem);
  const versionStem = split?.[1] ?? stem;
  const part = split?.[2] === undefined ? null : Number(split[2]);
  const episode = episodeNumbers(versionStem);
  if (episode === null || episode.season !== season) {
    return null;
  }
  return {
    canonicalFolder,
    seasonFolder,
    seasonNumber: season,
    episodeNumber: episode.start,
    episodeEndNumber: episode.end,
    versionKey:
      part === null ? `file:${path}` : `stem:${seasonFolder}:${versionStem}`,
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
  const accepted = analyze(path);
  if (accepted === null) {
    return null;
  }
  return { kind: "episode", canonicalFolder: accepted.canonicalFolder };
}

function parse(canonicalFolder: string): {
  title: string;
  year: number | null;
} {
  const folder = posix
    .basename(canonicalFolder)
    .replace(/\s*\{(?:tmdb|imdb|tvdb)[-=][^}]+\}/gi, "")
    .trim();
  const match = /^(.*?)\s*\((\d{4})\)(?:\s.*)?$/.exec(folder);
  const rawTitle = (match?.[1] ?? folder).trim();
  const title = rawTitle.includes(" ")
    ? rawTitle
    : rawTitle.replace(/[._]/g, " ");
  return { title, year: match?.[2] ? Number(match[2]) : null };
}

/** One grouped Version of an Episode, with split Files in playback order. */
export interface ShowVersionPathGroup {
  paths: string[];
}

/** One Episode parsed from accepted paths. */
export interface EpisodePathGroup {
  episodeNumber: number;
  episodeEndNumber: number | null;
  title: string;
  versions: ShowVersionPathGroup[];
}

/** One Season under a canonical Show folder. */
export interface SeasonPathGroup {
  canonicalFolder: string;
  seasonNumber: number;
  title: string;
  episodes: EpisodePathGroup[];
}

/** One canonical Show folder and its accepted Seasons and Episodes. */
export interface ShowPathGroup {
  canonicalFolder: string;
  title: string;
  year: number | null;
  seasons: SeasonPathGroup[];
}

/** Group accepted library-relative paths into canonical Shows, Seasons, Episodes and Versions. */
export function groupShowPaths(paths: Iterable<string>): ShowPathGroup[] {
  const groups = new Map<
    string,
    Map<
      number,
      {
        seasonFolder: string;
        seasonNumber: number;
        episodes: Map<
          number,
          {
            end: number | null;
            versions: Map<string, { part: number | null; path: string }[]>;
          }
        >;
      }
    >
  >();
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const accepted = analyze(path);
    if (accepted === null) {
      continue;
    }
    let seasons = groups.get(accepted.canonicalFolder);
    if (!seasons) {
      seasons = new Map();
      groups.set(accepted.canonicalFolder, seasons);
    }
    let season = seasons.get(accepted.seasonNumber);
    if (!season) {
      season = {
        seasonFolder: accepted.seasonFolder,
        seasonNumber: accepted.seasonNumber,
        episodes: new Map(),
      };
      seasons.set(accepted.seasonNumber, season);
    } else if (accepted.seasonFolder.localeCompare(season.seasonFolder) < 0) {
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
    let version = episode.versions.get(accepted.versionKey);
    if (!version) {
      version = [];
      episode.versions.set(accepted.versionKey, version);
    }
    version.push({ part: accepted.part, path });
  }
  return [...groups.entries()]
    .map(([canonicalFolder, seasons]) => ({
      canonicalFolder,
      ...parse(canonicalFolder),
      seasons: [...seasons.values()]
        .map((season) => ({
          canonicalFolder: `${canonicalFolder}/${season.seasonFolder}`,
          seasonNumber: season.seasonNumber,
          title:
            season.seasonNumber === 0
              ? "Specials"
              : `Season ${season.seasonNumber}`,
          episodes: [...season.episodes.entries()]
            .map(([episodeNumber, episode]) => ({
              episodeNumber,
              episodeEndNumber: episode.end,
              title:
                episode.end === null
                  ? `Episode ${episodeNumber}`
                  : `Episodes ${episodeNumber}-${episode.end}`,
              versions: [...episode.versions.values()]
                .map(
                  (files): ShowVersionPathGroup => ({
                    paths: files
                      .sort(
                        (a, b) =>
                          (a.part ?? 0) - (b.part ?? 0) ||
                          a.path.localeCompare(b.path),
                      )
                      .map((file) => file.path),
                  }),
                )
                .sort((a, b) =>
                  (a.paths[0] ?? "").localeCompare(b.paths[0] ?? ""),
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
    .sort((a, b) => a.canonicalFolder.localeCompare(b.canonicalFolder));
}
