import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  episodes,
  groups,
  items,
  libraryAccess,
  progress,
  seasons,
  userGroups,
  users,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { insertLibraries } from "../libraries/testing.ts";
import {
  createShowsMedium,
  groupShowPaths,
  nextUp,
  showsScan,
} from "./shows.ts";

const { identify, parse, isExtra } = showsScan;

/** Turns plain paths into single-root walked files for groupShowPaths. */
const rooted = (paths: string[], rootName = "library", rootId = "root") =>
  paths.map((path) => ({ rootId, rootName, path }));

const version = (paths: string[], rootId = "root") => ({ rootId, paths });

describe("identify", () => {
  test("identifies an episode under a tagged Sonarr show folder", () => {
    expect(
      identify(
        "The Expanse (2015) {tvdb-280619}/Season 01/The Expanse S01E01.mkv",
      ),
    ).toEqual({
      kind: "episode",
      canonicalFolder: "The Expanse (2015) {tvdb-280619}",
    });
  });

  test("accepts Specials as season zero", () => {
    expect(
      identify("The Expanse (2015)/Specials/The Expanse S00E01.mkv"),
    ).not.toBeNull();
  });

  test("accepts a filename season that disagrees with its folder", () => {
    expect(
      identify("The Expanse (2015)/Season 01/The Expanse S02E01.mkv"),
    ).toEqual({
      kind: "episode",
      canonicalFolder: "The Expanse (2015)",
    });
    expect(
      identify("The Expanse (2015)/Specials/The Expanse S01E01.mkv"),
    ).toEqual({
      kind: "episode",
      canonicalFolder: "The Expanse (2015)",
    });
  });

  test("accepts separated season folder spellings", () => {
    for (const folder of [
      "Season 1",
      "season.02",
      "SEASON_3",
      "Season-4",
      "Season05",
      "Series 1",
      "S02",
      "s3",
    ]) {
      const number = Number(folder.replace(/\D+/g, ""));
      const tag = `S${String(number).padStart(2, "0")}E01`;
      expect(identify(`Show/${folder}/Show ${tag}.mkv`)).toEqual({
        kind: "episode",
        canonicalFolder: "Show",
      });
    }
  });

  test("accepts every episode token form", () => {
    for (const file of [
      "Show S01E01.mkv",
      "Show s1e2.mkv",
      "Show S01E02-E03.mkv",
      "Show S01E02-03.mkv",
      "Show S01E02E03.mkv",
      "Show.S01E02.1080p.mkv",
      "Show S01.E02.mkv",
      "Show 1x02.mkv",
      "Show 1x02-03.mkv",
      "Show E02.mkv",
      "Show Ep 02.mkv",
      "Show Episode 2.mkv",
    ]) {
      expect(identify(`Show/Season 01/${file}`)).toEqual({
        kind: "episode",
        canonicalFolder: "Show",
      });
    }
  });

  test("keeps a show folder named like an episode-only token", () => {
    expect(
      identify("Episode 1 Fans/Season 1/Episode 1 Fans - S01E01.mkv"),
    ).toEqual({
      kind: "episode",
      canonicalFolder: "Episode 1 Fans",
    });
  });

  test("rejects tokens without separator boundaries", () => {
    expect(identify("Show/Season 01/ShowS01E01.mkv")).toBeNull();
    expect(identify("Show/Season 01/Show S01E01v2.mkv")).toBeNull();
  });

  test("rejects descending episode ranges", () => {
    expect(identify("Show/Season 01/Show S01E03-E02.mkv")).toBeNull();
    expect(identify("Show/Season 01/Show S01E05E02.mkv")).toBeNull();
  });

  test("rejects files without an episode token", () => {
    expect(identify("Show/Season 01/clip.mkv")).toBeNull();
    expect(identify("Show/Season 01/Show trailer.mkv")).toBeNull();
  });

  test("rejects extras directories, suffixes and Pendia store paths", () => {
    expect(identify("Show/Season 01/extras/clip S01E01.mkv")).toBeNull();
    expect(identify("Show/Season 01/Show S01E01-trailer.mkv")).toBeNull();
    expect(identify("Show/Season 01/Show S01E01.sample.mkv")).toBeNull();
    expect(identify("Show/.pendia/cover S01E01.mkv")).toBeNull();
    expect(
      identify("Show/Season 01/file.mkv.pendia/init S01E01.mp4"),
    ).toBeNull();
    expect(identify("extras/Season 01/extras S01E01.mkv")).toBeNull();
  });

  test("keeps a canonical show named after an extras category", () => {
    expect(identify("Shorts/Season 01/Shorts S01E01.mkv")).toEqual({
      kind: "episode",
      canonicalFolder: "Shorts",
    });
    expect(identify("Shorts/Specials/Shorts S00E01.mkv")).toEqual({
      kind: "episode",
      canonicalFolder: "Shorts",
    });
  });

  test("accepts episodes at any depth and rejects unsafe paths", () => {
    expect(identify("/library/Show/Season 01/Show S01E01.mkv")).toBeNull();
    expect(identify("../Show/Season 01/Show S01E01.mkv")).toBeNull();
    expect(identify("Show/../Season 01/Show S01E01.mkv")).toBeNull();
    expect(identify("Show S01E01.mkv")).toEqual({
      kind: "episode",
      canonicalFolder: ".",
    });
    expect(identify("Show/Show S01E01.mkv")).toEqual({
      kind: "episode",
      canonicalFolder: "Show",
    });
    expect(identify("Show/Season 01/nested/Show S01E01.mkv")).toEqual({
      kind: "episode",
      canonicalFolder: "Show/Season 01/nested",
    });
  });

  test("rejects split extras after removing the part marker", () => {
    for (const path of [
      "Show/Season 01/Show S01E01-trailer-part1.mkv",
      "Show/Season 01/Show S01E01.sample.pt2.mkv",
      "Show/Season 01/Show S01E01_featurette_cd3.mkv",
    ]) {
      expect(identify(path)).toBeNull();
      expect(groupShowPaths(rooted([path]))).toEqual([]);
    }
    expect(identify("Show/Season 01/Show S01E01 - part1.mkv")).toEqual({
      kind: "episode",
      canonicalFolder: "Show",
    });
  });

  test("rejects non-video files", () => {
    expect(identify("Show/Season 01/Show S01E01.srt")).toBeNull();
    expect(identify("Show/Season 01/Show S01E01.jpg")).toBeNull();
  });
});

describe("parse", () => {
  test("reads title and year from a tagged show folder", () => {
    expect(parse("The Expanse (2015) {tvdb-280619}")).toEqual({
      title: "The Expanse",
      year: 2015,
    });
  });

  test("accepts a title-only folder and expands tight titles", () => {
    expect(parse("The Expanse")).toEqual({ title: "The Expanse", year: null });
    expect(parse("The.Expanse (2015)")).toEqual({
      title: "The Expanse",
      year: 2015,
    });
  });
});

describe("isExtra", () => {
  test("flags extras under the show folder but not the show folder itself", () => {
    expect(isExtra("Show/Season 01/extras/clip.mkv")).toBe(true);
    expect(isExtra("Show/Season 01/Show S01E01-trailer.mkv")).toBe(true);
    expect(isExtra("Show/Season 01/Show S01E01.mkv")).toBe(false);
    expect(isExtra("Shorts/Season 01/Shorts S01E01.mkv")).toBe(false);
    expect(isExtra("extras/Season 01/extras S01E01.mkv")).toBe(true);
    expect(isExtra("Show/.pendia/cover.mkv")).toBe(true);
  });
});

describe("groupShowPaths", () => {
  test("groups one show into seasons, episodes and split versions", () => {
    const groups = groupShowPaths(
      rooted([
        "The Expanse (2015)/Season 01/The Expanse S01E01 - part2.mkv",
        "The Expanse (2015)/Specials/The Expanse S00E01.mkv",
        "The Expanse (2015)/Season 01/The Expanse S01E01 - part1.mkv",
        "The Expanse (2015)/Season 01/The Expanse S01E02-E03.mkv",
        "The Expanse (2015)/Season 01/The Expanse S01E04E05.mkv",
        "The Expanse (2015)/Season 01/The Expanse S01E06.mkv",
        "The Expanse (2015)/Season 01/The Expanse S01E06.1080p.mkv",
      ]),
    );
    expect(groups).toEqual([
      {
        canonicalFolder: "The Expanse (2015)",
        titleKey: "",
        title: "The Expanse",
        year: 2015,
        providerIds: {},
        seasons: [
          {
            canonicalFolder: "The Expanse (2015)/Specials",
            seasonNumber: 0,
            title: "Specials",
            episodes: [
              {
                episodeNumber: 1,
                episodeEndNumber: null,
                title: "Episode 1",
                versions: [
                  version([
                    "The Expanse (2015)/Specials/The Expanse S00E01.mkv",
                  ]),
                ],
              },
            ],
          },
          {
            canonicalFolder: "The Expanse (2015)/Season 01",
            seasonNumber: 1,
            title: "Season 1",
            episodes: [
              {
                episodeNumber: 1,
                episodeEndNumber: null,
                title: "Episode 1",
                versions: [
                  version([
                    "The Expanse (2015)/Season 01/The Expanse S01E01 - part1.mkv",
                    "The Expanse (2015)/Season 01/The Expanse S01E01 - part2.mkv",
                  ]),
                ],
              },
              {
                episodeNumber: 2,
                episodeEndNumber: 3,
                title: "Episodes 2-3",
                versions: [
                  version([
                    "The Expanse (2015)/Season 01/The Expanse S01E02-E03.mkv",
                  ]),
                ],
              },
              {
                episodeNumber: 4,
                episodeEndNumber: 5,
                title: "Episodes 4-5",
                versions: [
                  version([
                    "The Expanse (2015)/Season 01/The Expanse S01E04E05.mkv",
                  ]),
                ],
              },
              {
                episodeNumber: 6,
                episodeEndNumber: null,
                title: "Episode 6",
                versions: [
                  version([
                    "The Expanse (2015)/Season 01/The Expanse S01E06.1080p.mkv",
                  ]),
                  version([
                    "The Expanse (2015)/Season 01/The Expanse S01E06.mkv",
                  ]),
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("reads Sonarr and Jellyfin provider tags from the Show folder", () => {
    const [sonarr] = groupShowPaths(
      rooted([
        "The Expanse (2015) {tvdb-280619} {imdb-tt3230854}/Season 01/S01E01.mkv",
      ]),
    );
    expect(sonarr).toMatchObject({
      title: "The Expanse",
      year: 2015,
      providerIds: { tvdb: "280619", imdb: "tt3230854" },
    });
    const [jellyfin] = groupShowPaths(
      rooted(["The Expanse (2015) [tvdbid-280619]/Season 01/S01E01.mkv"]),
    );
    expect(jellyfin).toMatchObject({
      title: "The Expanse",
      providerIds: { tvdb: "280619" },
    });
  });

  test("groups every split marker spelling into one version", () => {
    const groups = groupShowPaths(
      rooted([
        "Show/Season 01/Show S01E01 pt2.mkv",
        "Show/Season 01/Show S01E01-cd1.mkv",
        "Show/Season 01/Show S01E01 - part3.mkv",
      ]),
    );
    expect(groups[0]?.seasons[0]?.episodes[0]?.versions).toEqual([
      version([
        "Show/Season 01/Show S01E01-cd1.mkv",
        "Show/Season 01/Show S01E01 pt2.mkv",
        "Show/Season 01/Show S01E01 - part3.mkv",
      ]),
    ]);
  });

  test("skips extras, unsafe paths and unsupported files", () => {
    const groups = groupShowPaths(
      rooted([
        "Show/Season 01/Show S01E01.mkv",
        "Show/Season 01/extras/clip S01E02.mkv",
        "Show/Season 01/Show S01E02-trailer.mkv",
        "Show/.pendia/cover S01E02.mkv",
        "extras/Season 01/extras S01E01.mkv",
        "Show/Season 01/Show S01E02.srt",
        "../escape/Season 01/Show S01E02.mkv",
        "/absolute/Season 01/Show S01E02.mkv",
      ]),
    );
    expect(groups).toEqual([
      {
        canonicalFolder: "Show",
        titleKey: "",
        title: "Show",
        year: null,
        providerIds: {},
        seasons: [
          {
            canonicalFolder: "Show/Season 01",
            seasonNumber: 1,
            title: "Season 1",
            episodes: [
              {
                episodeNumber: 1,
                episodeEndNumber: null,
                title: "Episode 1",
                versions: [version(["Show/Season 01/Show S01E01.mkv"])],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("merges equivalent season folder spellings by number", () => {
    const paths = [
      "Show/Season 1/Show S01E01.mkv",
      "Show/Season 01/Show S01E01-E02.mkv",
    ];
    for (const input of [paths, [...paths].reverse()]) {
      const [group] = groupShowPaths(rooted(input));
      expect(group?.seasons).toHaveLength(1);
      expect(group?.seasons[0]?.seasonNumber).toBe(1);
      expect(group?.seasons[0]?.canonicalFolder).toBe("Show/Season 01");
      expect(group?.seasons[0]?.episodes).toEqual([
        {
          episodeNumber: 1,
          episodeEndNumber: 2,
          title: "Episodes 1-2",
          versions: [
            version(["Show/Season 01/Show S01E01-E02.mkv"]),
            version(["Show/Season 1/Show S01E01.mkv"]),
          ],
        },
      ]);
    }
  });

  test("keeps split Versions separate across equivalent season folders", () => {
    const paths = [
      "Show/Season 1/Show S01E01 - part1.mkv",
      "Show/Season 01/Show S01E01 - part2.mkv",
    ];
    for (const input of [paths, [...paths].reverse()]) {
      const [group] = groupShowPaths(rooted(input));
      expect(group?.seasons).toHaveLength(1);
      expect(group?.seasons[0]?.seasonNumber).toBe(1);
      expect(group?.seasons[0]?.episodes).toHaveLength(1);
      const versions = group?.seasons[0]?.episodes[0]?.versions;
      expect(versions).toHaveLength(2);
      expect(versions?.map((version_) => version_.paths)).toEqual([
        ["Show/Season 01/Show S01E01 - part2.mkv"],
        ["Show/Season 1/Show S01E01 - part1.mkv"],
      ]);
    }
  });

  test("deduplicates repeated paths and sorts every level deterministically", () => {
    const input = [
      "B Show/Season 02/B Show S02E01.mkv",
      "A Show/Season 01/A Show S01E02.mkv",
      "B Show/Season 01/B Show S01E01.mkv",
      "B Show/Season 02/B Show S02E01.mkv",
      "A Show/Season 01/A Show S01E01.mkv",
      "A Show/Season 10/A Show S10E01.mkv",
    ];
    const first = groupShowPaths(rooted(input));
    const second = groupShowPaths(rooted([...input].reverse()));
    expect(first).toEqual(second);
    expect(first.map((group) => group.canonicalFolder)).toEqual([
      "A Show",
      "B Show",
    ]);
    expect(first[0]?.seasons.map((season) => season.seasonNumber)).toEqual([
      1, 10,
    ]);
    expect(
      first[0]?.seasons[0]?.episodes.map((episode) => episode.episodeNumber),
    ).toEqual([1, 2]);
    expect(first[1]?.seasons.map((season) => season.seasonNumber)).toEqual([
      1, 2,
    ]);
  });

  test("names a Sonarr episode folder by the show above it", () => {
    const folder = "Doctor Who 2005 (2005) [tvdbid-78804]";
    const path = `${folder}/Season 13/Doctor Who (2005) - S13E06 - The Vanquishers 6 [WEBDL-1080p] [NOSiViD]/Doctor Who (2005) - S13E06 - The Vanquishers 6 [WEBDL-1080p] - NOSiViD.mkv`;
    const [group] = groupShowPaths(rooted([path]));
    expect(group).toMatchObject({
      canonicalFolder: folder,
      titleKey: "",
      title: "Doctor Who 2005",
      year: 2005,
      providerIds: { tvdb: "78804" },
    });
    expect(group?.seasons).toEqual([
      {
        canonicalFolder: `${folder}/Season 13`,
        seasonNumber: 13,
        title: "Season 13",
        episodes: [
          {
            episodeNumber: 6,
            episodeEndNumber: null,
            title: "Episode 6",
            versions: [version([path])],
          },
        ],
      },
    ]);
  });

  test("anchors a season to the show folder when no season folder exists", () => {
    const folder = "Fairy Tail (2009) [tvdbid-114801]";
    const path = `${folder}/Fairy Tail (2009) - S02E06 - 054 - Maiden of the Sky [Bluray-1080p] [URANiME]/Fairy Tail (2009) - S02E06 - 054 - Maiden of the Sky [Bluray-1080p] - URANiME.mkv`;
    const [group] = groupShowPaths(rooted([path]));
    expect(group).toMatchObject({
      canonicalFolder: folder,
      titleKey: "",
      title: "Fairy Tail",
      year: 2009,
      providerIds: { tvdb: "114801" },
    });
    expect(group?.seasons).toEqual([
      {
        canonicalFolder: folder,
        seasonNumber: 2,
        title: "Season 2",
        episodes: [
          {
            episodeNumber: 6,
            episodeEndNumber: null,
            title: "Episode 6",
            versions: [version([path])],
          },
        ],
      },
    ]);
  });

  test("reads Specials folders at any depth as season zero", () => {
    const folder = "Doctor Who (2023) [tvdbid-449991]";
    const path = `${folder}/Specials/Doctor Who (2023) - S00E01 - The Star Beast [WEBDL-1080p] [Kitsune]/Doctor Who (2023) - S00E01 - The Star Beast [WEBDL-1080p] - Kitsune.mkv`;
    const [group] = groupShowPaths(rooted([path]));
    expect(group?.seasons[0]?.seasonNumber).toBe(0);
    expect(group?.seasons[0]?.canonicalFolder).toBe(`${folder}/Specials`);
  });

  test("names a single-show root from the root folder", () => {
    const groups = groupShowPaths(
      rooted(
        ["Season 1/Breaking Bad - S01E01.mkv", "Breaking.Bad.S01E02.mkv"],
        "Breaking Bad (2008)",
      ),
    );
    expect(groups).toEqual([
      {
        canonicalFolder: ".",
        titleKey: "breaking bad (2008)",
        title: "Breaking Bad",
        year: 2008,
        providerIds: {},
        seasons: [
          {
            canonicalFolder: "Season 1",
            seasonNumber: 1,
            title: "Season 1",
            episodes: [
              {
                episodeNumber: 1,
                episodeEndNumber: null,
                title: "Episode 1",
                versions: [version(["Season 1/Breaking Bad - S01E01.mkv"])],
              },
              {
                episodeNumber: 2,
                episodeEndNumber: null,
                title: "Episode 2",
                versions: [version(["Breaking.Bad.S01E02.mkv"])],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("keeps two single-show roots apart by title key", () => {
    const groups = groupShowPaths([
      {
        rootId: "a",
        rootName: "Breaking Bad (2008)",
        path: "Season 1/S01E01.mkv",
      },
      { rootId: "b", rootName: "The Wire (2002)", path: "Season 1/S01E01.mkv" },
    ]);
    expect(groups.map((group) => group.titleKey)).toEqual([
      "breaking bad (2008)",
      "the wire (2002)",
    ]);
    expect(groups.every((group) => group.canonicalFolder === ".")).toBe(true);
  });

  test("titles loose files in one folder as their own shows", () => {
    const groups = groupShowPaths(
      rooted([
        "TV/Breaking.Bad.S01E01.mkv",
        "TV/The.Wire.S01E01.mkv",
        "TV/Breaking Bad - S01E02.mkv",
      ]),
    );
    expect(groups).toMatchObject([
      {
        canonicalFolder: "TV",
        titleKey: "breaking bad",
        title: "Breaking Bad",
      },
      { canonicalFolder: "TV", titleKey: "the wire", title: "The Wire" },
    ]);
    const breaking = groups.find((group) => group.title === "Breaking Bad");
    expect(breaking?.seasons).toHaveLength(1);
    expect(breaking?.seasons[0]?.canonicalFolder).toBe("TV");
    expect(
      breaking?.seasons[0]?.episodes.map((episode) => episode.episodeNumber),
    ).toEqual([1, 2]);
  });

  test("reads episodes without a season folder", () => {
    const cases: [string, number, number][] = [
      ["Show/Show - E05.mkv", 1, 5],
      ["Show/Season 2/Ep 03.mkv", 2, 3],
      ["Show/Season 2/Episode 4.mkv", 2, 4],
      ["Show/S03/1x02.mkv", 1, 2],
      ["Show/Series 2/Show 2x05.mkv", 2, 5],
    ];
    for (const [path, season, episode] of cases) {
      const [group] = groupShowPaths(rooted([path]));
      expect(group?.seasons[0], path).toMatchObject({ seasonNumber: season });
      expect(group?.seasons[0]?.episodes[0]?.episodeNumber).toBe(episode);
    }
  });

  test("folds disc folders into the season above", () => {
    const [group] = groupShowPaths(
      rooted(["Show/Season 1/Disc 1/Show S01E01.mkv"]),
    );
    expect(group?.canonicalFolder).toBe("Show");
    expect(group?.seasons[0]?.canonicalFolder).toBe("Show/Season 1");
    expect(group?.seasons[0]?.episodes[0]?.episodeNumber).toBe(1);
  });

  test("rejects extras at any depth and absolute numbering", () => {
    for (const path of [
      "Show/Season 1/extras/x S01E01.mkv",
      "Show/Featurettes/Show S01E01.mkv",
      "Show/Season 01/Show S01E01.sample.mkv",
      "Show/.pendia/cover S01E01.mkv",
      "Show/Season 01/file.mkv.pendia/init S01E01.mp4",
      "Show/Show - 012.mkv",
    ]) {
      expect(groupShowPaths(rooted([path]))).toEqual([]);
    }
  });
});

interface FixtureShow {
  id: string;
  episodeIds: Map<string, string>;
}

async function addShow(
  db: Database,
  libraryId: string,
  title: string,
  seasonEpisodes: [number, number[]][],
): Promise<FixtureShow> {
  const show = await insertItem(db, {
    libraryId,
    kind: "show",
    title,
    canonicalFolder: title,
    extension: {},
  });
  const episodeIds = new Map<string, string>();
  for (const [seasonNumber, episodeNumbers] of seasonEpisodes) {
    const seasonFolder =
      seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
    const season = await insertItem(db, {
      libraryId,
      kind: "season",
      parentId: show.id,
      title: seasonFolder,
      canonicalFolder: `${title}/${seasonFolder}`,
      extension: { seasonNumber },
    });
    for (const episodeNumber of episodeNumbers) {
      const episode = await insertItem(db, {
        libraryId,
        kind: "episode",
        parentId: season.id,
        title: `Episode ${episodeNumber}`,
        canonicalFolder: `${title}/${seasonFolder}`,
        extension: { episodeNumber, episodeEndNumber: null },
      });
      episodeIds.set(`${seasonNumber}:${episodeNumber}`, episode.id);
    }
  }
  return { id: show.id, episodeIds };
}

function episodeId(
  show: FixtureShow,
  seasonNumber: number,
  episodeNumber: number,
) {
  const id = show.episodeIds.get(`${seasonNumber}:${episodeNumber}`);
  if (!id) throw new Error("Fixture Episode missing.");
  return id;
}

async function seedShows(db: Database) {
  const [library] = await insertLibraries(db, {
    name: "Shows",
    medium: "shows",
    rootPath: "/srv/shows",
  });
  if (!library) throw new Error("Fixture library missing.");
  const [userA, userB] = await db
    .insert(users)
    .values([
      { username: "user-a", displayName: "User A", passwordHash: "hash-a" },
      { username: "user-b", displayName: "User B", passwordHash: "hash-b" },
    ])
    .returning();
  if (!userA || !userB) throw new Error("Fixture users missing.");
  const [usersGroup] = await db
    .select()
    .from(groups)
    .where(eq(groups.name, "users"));
  if (!usersGroup) throw new Error("Built-in users group missing.");
  await db.insert(userGroups).values([
    { userId: userA.id, groupId: usersGroup.id },
    { userId: userB.id, groupId: usersGroup.id },
  ]);

  const showA = await addShow(db, library.id, "Show A", [
    [0, [1]],
    [1, [1, 2]],
    [2, [1]],
  ]);
  const showB = await addShow(db, library.id, "Show B", [
    [1, [1]],
    [2, [1]],
  ]);
  const finished = await addShow(db, library.id, "Finished Show", [
    [1, [1, 2]],
  ]);
  await addShow(db, library.id, "Unstarted Show", [[1, [1]]]);

  expect(await db.select().from(items)).toHaveLength(20);
  expect(await db.select().from(seasons)).toHaveLength(7);
  expect(await db.select().from(episodes)).toHaveLength(9);

  const watched = (
    userId: string,
    itemId: string,
    playedAt: string,
    completed = true,
    positionSeconds = 0,
  ) => ({
    userId,
    itemId,
    format: "video" as const,
    completed,
    positionSeconds,
    playedAt: new Date(playedAt),
  });
  await db
    .insert(progress)
    .values([
      watched(userA.id, episodeId(showA, 0, 1), "2026-01-01T00:00:00Z"),
      watched(userA.id, episodeId(showA, 1, 1), "2026-03-01T00:00:00Z"),
      watched(
        userA.id,
        episodeId(showA, 1, 2),
        "2026-05-01T00:00:00Z",
        false,
        120,
      ),
      watched(userA.id, episodeId(showB, 1, 1), "2026-04-01T00:00:00Z"),
      watched(userA.id, episodeId(finished, 1, 1), "2026-02-01T00:00:00Z"),
      watched(userA.id, episodeId(finished, 1, 2), "2026-02-02T00:00:00Z"),
      watched(userB.id, episodeId(showA, 0, 1), "2026-06-01T00:00:00Z"),
    ]);
  return { userA, userB, showA, showB };
}

describe.skipIf(!databaseUrl)("next up", () => {
  test("returns the first unwatched Episode after each last completed one", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { userA, userB, showA, showB } = await seedShows(db);

      expect(await nextUp(db, userA.id)).toEqual([
        episodeId(showB, 2, 1),
        episodeId(showA, 1, 2),
      ]);
      expect(await nextUp(db, userB.id)).toEqual([episodeId(showA, 1, 1)]);
      expect(await nextUp(db, Bun.randomUUIDv7())).toEqual([]);
    }));

  test("excludes a library after view access is revoked", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { userA, showA, showB } = await seedShows(db);

      const [deniedLibrary] = await insertLibraries(db, {
        name: "Denied",
        medium: "shows",
        rootPath: "/srv/denied",
      });
      if (!deniedLibrary) throw new Error("Fixture library missing.");
      const denied = await addShow(db, deniedLibrary.id, "Denied Show", [
        [1, [1, 2]],
      ]);
      const deniedNextId = episodeId(denied, 1, 2);
      await db.insert(progress).values({
        userId: userA.id,
        itemId: episodeId(denied, 1, 1),
        format: "video",
        completed: true,
        playedAt: new Date("2026-07-01T00:00:00Z"),
      });

      expect(await nextUp(db, userA.id)).toContain(deniedNextId);

      await db.insert(libraryAccess).values({
        libraryId: deniedLibrary.id,
        userId: userA.id,
        allowed: false,
      });
      expect(await nextUp(db, userA.id)).toEqual([
        episodeId(showB, 2, 1),
        episodeId(showA, 1, 2),
      ]);
    }));

  test("exposes the next up shelf through the database-bound factory", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const { userA, showA, showB } = await seedShows(db);

      const medium = createShowsMedium(db);
      expect(
        medium.kinds.map(({ kind, parent, hasVersions }) => ({
          kind,
          parent,
          hasVersions,
        })),
      ).toEqual([
        { kind: "show", parent: null, hasVersions: false },
        { kind: "season", parent: "show", hasVersions: false },
        { kind: "episode", parent: "season", hasVersions: true },
      ]);
      expect(medium.browse.coreShelves).toEqual([
        "continue-watching",
        "recently-added",
      ]);
      expect(medium.browse.screens).toEqual({
        show: "/shows/:id",
        season: "/shows/:showId/seasons/:id",
        episode: "/shows/:showId/seasons/:seasonId/episodes/:id",
      });
      expect(
        medium.browse.shelves.map(({ id, title }) => ({ id, title })),
      ).toEqual([{ id: "next-up", title: "Next up" }]);
      expect(
        await medium.browse.shelves[0]?.items({ userId: userA.id }),
      ).toEqual([episodeId(showB, 2, 1), episodeId(showA, 1, 2)]);
    }));
});
