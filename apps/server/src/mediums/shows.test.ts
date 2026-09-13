import { describe, expect, test } from "bun:test";
import { groupShowPaths, showsMedium } from "./shows.ts";

const { identify, parse, isExtra } = showsMedium.scan;

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
