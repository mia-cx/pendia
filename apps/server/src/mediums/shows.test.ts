import { describe, expect, test } from "bun:test";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  episodes,
  items,
  libraries,
  progress,
  seasons,
  users,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import {
  createShowsMedium,
  groupShowPaths,
  nextUp,
  showsScan,
} from "./shows.ts";

const { identify, parse, isExtra } = showsScan;

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

  test("rejects a filename season that disagrees with its folder", () => {
    expect(
      identify("The Expanse (2015)/Season 01/The Expanse S02E01.mkv"),
    ).toBeNull();
    expect(
      identify("The Expanse (2015)/Specials/The Expanse S01E01.mkv"),
    ).toBeNull();
  });

  test("accepts separated season folder spellings", () => {
    for (const folder of [
      "Season 1",
      "season.02",
      "SEASON_3",
      "Season-4",
      "Season05",
    ]) {
      const number = Number(folder.replace(/\D+/g, ""));
      const tag = `S${String(number).padStart(2, "0")}E01`;
      expect(identify(`Show/${folder}/Show ${tag}.mkv`)).toEqual({
        kind: "episode",
        canonicalFolder: "Show",
      });
    }
  });

  test("accepts every episode token form with matching season", () => {
    for (const file of [
      "Show S01E01.mkv",
      "Show S1E001.mkv",
      "Show S01E02-E03.mkv",
      "Show S01E02-03.mkv",
      "Show S01E02E03.mkv",
      "Show.S01E02.1080p.mkv",
    ]) {
      expect(identify(`Show/Season 01/${file}`)).toEqual({
        kind: "episode",
        canonicalFolder: "Show",
      });
    }
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

  test("rejects absolute, escaping and wrong-depth paths", () => {
    expect(identify("/library/Show/Season 01/Show S01E01.mkv")).toBeNull();
    expect(identify("../Show/Season 01/Show S01E01.mkv")).toBeNull();
    expect(identify("Show/../Season 01/Show S01E01.mkv")).toBeNull();
    expect(identify("Show S01E01.mkv")).toBeNull();
    expect(identify("Show/Show S01E01.mkv")).toBeNull();
    expect(identify("Show/Season 01/nested/Show S01E01.mkv")).toBeNull();
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
    const groups = groupShowPaths([
      "The Expanse (2015)/Season 01/The Expanse S01E01 - part2.mkv",
      "The Expanse (2015)/Specials/The Expanse S00E01.mkv",
      "The Expanse (2015)/Season 01/The Expanse S01E01 - part1.mkv",
      "The Expanse (2015)/Season 01/The Expanse S01E02-E03.mkv",
      "The Expanse (2015)/Season 01/The Expanse S01E04E05.mkv",
      "The Expanse (2015)/Season 01/The Expanse S01E06.mkv",
      "The Expanse (2015)/Season 01/The Expanse S01E06.1080p.mkv",
    ]);
    expect(groups).toEqual([
      {
        canonicalFolder: "The Expanse (2015)",
        title: "The Expanse",
        year: 2015,
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
                  {
                    paths: [
                      "The Expanse (2015)/Specials/The Expanse S00E01.mkv",
                    ],
                  },
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
                  {
                    paths: [
                      "The Expanse (2015)/Season 01/The Expanse S01E01 - part1.mkv",
                      "The Expanse (2015)/Season 01/The Expanse S01E01 - part2.mkv",
                    ],
                  },
                ],
              },
              {
                episodeNumber: 2,
                episodeEndNumber: 3,
                title: "Episodes 2-3",
                versions: [
                  {
                    paths: [
                      "The Expanse (2015)/Season 01/The Expanse S01E02-E03.mkv",
                    ],
                  },
                ],
              },
              {
                episodeNumber: 4,
                episodeEndNumber: 5,
                title: "Episodes 4-5",
                versions: [
                  {
                    paths: [
                      "The Expanse (2015)/Season 01/The Expanse S01E04E05.mkv",
                    ],
                  },
                ],
              },
              {
                episodeNumber: 6,
                episodeEndNumber: null,
                title: "Episode 6",
                versions: [
                  {
                    paths: [
                      "The Expanse (2015)/Season 01/The Expanse S01E06.1080p.mkv",
                    ],
                  },
                  {
                    paths: [
                      "The Expanse (2015)/Season 01/The Expanse S01E06.mkv",
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("groups every split marker spelling into one version", () => {
    const groups = groupShowPaths([
      "Show/Season 01/Show S01E01 pt2.mkv",
      "Show/Season 01/Show S01E01-cd1.mkv",
      "Show/Season 01/Show S01E01 - part3.mkv",
    ]);
    expect(groups[0]?.seasons[0]?.episodes[0]?.versions).toEqual([
      {
        paths: [
          "Show/Season 01/Show S01E01-cd1.mkv",
          "Show/Season 01/Show S01E01 pt2.mkv",
          "Show/Season 01/Show S01E01 - part3.mkv",
        ],
      },
    ]);
  });

  test("skips extras, unsafe paths and unsupported files", () => {
    const groups = groupShowPaths([
      "Show/Season 01/Show S01E01.mkv",
      "Show/Season 01/extras/clip S01E02.mkv",
      "Show/Season 01/Show S01E02-trailer.mkv",
      "Show/.pendia/cover S01E02.mkv",
      "extras/Season 01/extras S01E01.mkv",
      "Show/Season 01/Show S01E02.srt",
      "Show/Show S01E02.mkv",
      "loose S01E02.mkv",
      "Show/Season 01/nested/Show S01E02.mkv",
      "../escape/Season 01/Show S01E02.mkv",
      "/absolute/Season 01/Show S01E02.mkv",
    ]);
    expect(groups).toEqual([
      {
        canonicalFolder: "Show",
        title: "Show",
        year: null,
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
                versions: [{ paths: ["Show/Season 01/Show S01E01.mkv"] }],
              },
            ],
          },
        ],
      },
    ]);
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
    const first = groupShowPaths(input);
    const second = groupShowPaths([...input].reverse());
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
  const [library] = await db
    .insert(libraries)
    .values({ name: "Shows", medium: "shows", rootPath: "/srv/shows" })
    .returning();
  if (!library) throw new Error("Fixture library missing.");
  const [userA, userB] = await db
    .insert(users)
    .values([
      { username: "user-a", displayName: "User A", passwordHash: "hash-a" },
      { username: "user-b", displayName: "User B", passwordHash: "hash-b" },
    ])
    .returning();
  if (!userA || !userB) throw new Error("Fixture users missing.");

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
