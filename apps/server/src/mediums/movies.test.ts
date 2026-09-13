import { describe, expect, test } from "bun:test";
import { groupMoviePaths, moviesMedium } from "./movies.ts";
import { editionTag, isVideoExtra, isVideoPath } from "./video-common/paths.ts";

const { identify, parse, isExtra } = moviesMedium.scan;

describe("isVideoPath", () => {
  test("accepts supported extensions case-insensitively", () => {
    expect(isVideoPath("Alien (1979)/Alien.MKV")).toBe(true);
    expect(isVideoPath("Alien (1979)/Alien.m2ts")).toBe(true);
  });

  test("rejects non-video files", () => {
    expect(isVideoPath("Alien (1979)/Alien.srt")).toBe(false);
    expect(isVideoPath("Alien (1979)/poster.jpg")).toBe(false);
  });
});

describe("isVideoExtra", () => {
  test("flags extras directories", () => {
    expect(isVideoExtra("Alien (1979)/extras/making-of.mkv")).toBe(true);
    expect(isVideoExtra("Alien (1979)/Behind-the-Scenes/clip.mkv")).toBe(true);
    expect(isVideoExtra("Alien (1979)/Deleted Scenes/cut.mkv")).toBe(true);
  });

  test("flags extra filename suffixes", () => {
    expect(isVideoExtra("Alien (1979)/Alien-trailer.mkv")).toBe(true);
    expect(isVideoExtra("Alien (1979)/Alien.sample.mkv")).toBe(true);
    expect(isVideoExtra("Alien (1979)/Alien_featurette.mkv")).toBe(true);
  });

  test("recognizes dotted compound extras directories", () => {
    for (const folder of ["Behind.The.Scenes", "Deleted.Scenes"]) {
      const path = `Alien (1979)/${folder}/clip.mkv`;
      expect(isVideoExtra(path)).toBe(true);
      expect(identify(path)).toBeNull();
    }
  });

  test("flags Pendia store paths", () => {
    expect(isVideoExtra("Alien (1979)/.pendia/artwork.mkv")).toBe(true);
    expect(isVideoExtra("Alien (1979)/file.mkv.pendia/init.mp4")).toBe(true);
  });

  test("keeps regular versions", () => {
    expect(isVideoExtra("Alien (1979)/Alien.1979.2160p.mkv")).toBe(false);
  });
});

describe("editionTag", () => {
  test("extracts an explicit edition tag", () => {
    expect(editionTag("Alien (1979)/Alien {edition-Director's Cut}.mkv")).toBe(
      "Director's Cut",
    );
  });

  test("returns null without a tag", () => {
    expect(editionTag("Alien (1979)/Alien.1979.2160p.mkv")).toBeNull();
  });
});

describe("identify", () => {
  test("identifies a video by its immediate containing folder", () => {
    expect(identify("Alien (1979)/Alien.1979.2160p.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Alien (1979)",
    });
  });

  test("keeps the full parent for nested collection folders", () => {
    expect(identify("Collection/Alien (1979) {tmdb-348}/copy.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Collection/Alien (1979) {tmdb-348}",
    });
  });

  test("rejects extras and Pendia store paths", () => {
    expect(identify("Alien (1979)/extras/making-of.mkv")).toBeNull();
    expect(identify("Alien (1979)/Alien-trailer.mkv")).toBeNull();
    expect(identify("Alien (1979)/Alien-sample.mkv")).toBeNull();
    expect(identify("Alien (1979)/.pendia/cover.mkv")).toBeNull();
    expect(identify("Alien (1979)/file.mkv.pendia/init.mp4")).toBeNull();
  });

  test("rejects absolute and escaping paths", () => {
    expect(identify("/library/Alien (1979)/Alien.mkv")).toBeNull();
    expect(identify("../Alien (1979)/Alien.mkv")).toBeNull();
    expect(identify("Alien (1979)/../Alien.mkv")).toBeNull();
  });

  test("rejects files at the library root and non-video files", () => {
    expect(identify("Alien.mkv")).toBeNull();
    expect(identify("Alien (1979)/Alien.srt")).toBeNull();
  });

  test("identifies a title-matching file in an extras-named top folder", () => {
    expect(identify("Shorts/Shorts.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Shorts",
    });
    expect(identify("Interviews/Interviews.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Interviews",
    });
    expect(identify("Shorts/other.mkv")).toBeNull();
    expect(identify("Alien (1979)/shorts/clip.mkv")).toBeNull();
  });

  test("identifies extras-named movies inside nested collections", () => {
    expect(identify("Collection/Shorts/Shorts.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Collection/Shorts",
    });
    expect(identify("Collection/Set/Interviews/Interviews.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Collection/Set/Interviews",
    });
    expect(identify("Alien (1979)/shorts/clip.mkv")).toBeNull();
    expect(identify("Alien (1979)/extras/Shorts/Shorts.mkv")).toBeNull();
    expect(identify("Collection/.pendia/Shorts/Shorts.mkv")).toBeNull();
  });

  test("reserves extras directories even when a file matches their name", () => {
    expect(identify("extras/extras.mkv")).toBeNull();
    expect(identify("Alien (1979)/extras/extras.mkv")).toBeNull();
    expect(identify("Collection/EXTRAS/EXTRAS.mkv")).toBeNull();
    expect(identify("Extras (2005)/Extras.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Extras (2005)",
    });
    expect(identify("Collection/Shorts/Shorts.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Collection/Shorts",
    });
  });

  test("excludes separated and plural extra suffixes but retains movie titles", () => {
    for (const suffix of [
      "behind-the-scenes",
      "behind_the_scenes",
      "behind.the.scenes",
      "deleted-scenes",
      "deleted_scenes",
      "deleted.scenes",
      "deleted",
      "trailers",
      "samples",
      "featurettes",
      "interviews",
      "scenes",
      "shorts",
    ]) {
      expect(identify(`Alien (1979)/Alien-${suffix}.mkv`)).toBeNull();
    }
    expect(identify("Behind the Scenes (2020)/Behind-the-Scenes.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Behind the Scenes (2020)",
    });
  });

  test("never identifies Pendia store paths even under matching names", () => {
    expect(identify(".pendia/.pendia.mkv")).toBeNull();
    expect(identify("film.mkv.pendia/film.mkv.pendia.mkv")).toBeNull();
  });

  test("identifies films whose titles end in extra words", () => {
    expect(identify("The Interview (2014)/The Interview.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "The Interview (2014)",
    });
    expect(identify("The Interview (2014)/The.Interview.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "The Interview (2014)",
    });
    expect(identify("The Short (2020)/The.Short.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "The Short (2020)",
    });
    expect(identify("Sample (2000)/sample.mkv")).toEqual({
      kind: "movie",
      canonicalFolder: "Sample (2000)",
    });
  });
});

describe("parse", () => {
  test("reads title and year from a movie folder", () => {
    expect(parse("Alien (1979)")).toEqual({ title: "Alien", year: 1979 });
  });

  test("strips Radarr provider suffixes", () => {
    expect(parse("Collection/Alien (1979) {tmdb-348}")).toEqual({
      title: "Alien",
      year: 1979,
    });
    expect(parse("Alien (1979) {imdb-tt0078748}")).toEqual({
      title: "Alien",
      year: 1979,
    });
    expect(parse("Alien (1979) {TVDB=123} {tmdb-}")).toEqual({
      title: "Alien",
      year: 1979,
    });
  });

  test("accepts a title-only folder", () => {
    expect(parse("Alien")).toEqual({ title: "Alien", year: null });
  });

  test("retains punctuation inside spaced titles", () => {
    expect(parse("Dr. Strangelove (1964)")).toEqual({
      title: "Dr. Strangelove",
      year: 1964,
    });
  });

  test("expands dot and underscore separators in tight titles", () => {
    expect(parse("Dr.Strangelove (1964)")).toEqual({
      title: "Dr Strangelove",
      year: 1964,
    });
  });
});

describe("isExtra", () => {
  test("matches the video-common extra rules", () => {
    expect(isExtra("Alien (1979)/Alien-trailer.mkv")).toBe(true);
    expect(isExtra("Alien (1979)/Alien.1979.2160p.mkv")).toBe(false);
  });

  test("keeps films whose titles end in extra words", () => {
    expect(isExtra("The Interview (2014)/The Interview.mkv")).toBe(false);
    expect(isExtra("The Interview (2014)/The.Interview.mkv")).toBe(false);
    expect(isExtra("The Short (2020)/The.Short.mkv")).toBe(false);
    expect(isExtra("Sample (2000)/sample.mkv")).toBe(false);
  });

  test("a title match disambiguates the canonical folder", () => {
    expect(isExtra("Shorts/Shorts.mkv")).toBe(false);
    expect(isExtra("Shorts/other.mkv")).toBe(true);
    expect(isExtra("Shorts/extras/clip.mkv")).toBe(true);
    expect(isExtra("Alien (1979)/shorts/clip.mkv")).toBe(true);
  });

  test("still flags real extras under an ambiguous title", () => {
    expect(isExtra("The Interview (2014)/The Interview-trailer.mkv")).toBe(
      true,
    );
    expect(isExtra("The Interview (2014)/The Interview.sample.mkv")).toBe(true);
    expect(isExtra("The Interview (2014)/extras/The Interview.mkv")).toBe(true);
  });
});

describe("groupMoviePaths", () => {
  test("groups resolution variants of one film into a single group", () => {
    const groups = groupMoviePaths([
      "Alien (1979)/Alien.1979.1080p.mkv",
      "Alien (1979)/Alien.1979.2160p.mkv",
    ]);
    expect(groups).toEqual([
      {
        canonicalFolder: "Alien (1979)",
        title: "Alien",
        year: 1979,
        providerIds: {},
        paths: [
          "Alien (1979)/Alien.1979.1080p.mkv",
          "Alien (1979)/Alien.1979.2160p.mkv",
        ],
      },
    ]);
  });

  test("extracts Radarr provider ids from the canonical folder", () => {
    const folder = "Alien (1979) {tmdb-348} {imdb-tt78748} {tvdb=123}";
    const groups = groupMoviePaths([`${folder}/Alien.mkv`]);
    expect(groups).toEqual([
      {
        canonicalFolder: folder,
        title: "Alien",
        year: 1979,
        providerIds: { tmdb: "348", imdb: "tt78748", tvdb: "123" },
        paths: [`${folder}/Alien.mkv`],
      },
    ]);
  });

  test("lowercases providers, trims values and keeps the first duplicate", () => {
    const folder = "Alien (1979) {TMDB- 348 } {tmdb-999} {Imdb=TT78748}";
    const [group] = groupMoviePaths([`${folder}/Alien.mkv`]);
    expect(group?.providerIds).toEqual({ tmdb: "348", imdb: "tt78748" });
    expect(group?.title).toBe("Alien");
  });

  test("ignores malformed values and keeps a later valid duplicate", () => {
    const folder =
      "Alien (1979) {tmdb-abc} {imdb-123} {tvdb-x2} {tmdb-0} {imdb-tt0} {tmdb-348}";
    const [group] = groupMoviePaths([`${folder}/Alien.mkv`]);
    expect(group?.providerIds).toEqual({ tmdb: "348" });
    expect(group?.title).toBe("Alien");
  });

  test("ignores empty provider id values", () => {
    const folder = "Alien (1979) {tmdb-} {tvdb- }";
    const [group] = groupMoviePaths([`${folder}/Alien.mkv`]);
    expect(group?.providerIds).toEqual({});
    expect(group?.title).toBe("Alien");
  });

  test("does not split explicit edition tags into separate groups", () => {
    const groups = groupMoviePaths([
      "Alien (1979)/Alien {edition-Director's Cut}.mkv",
      "Alien (1979)/Alien.mkv",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.paths).toEqual([
      "Alien (1979)/Alien {edition-Director's Cut}.mkv",
      "Alien (1979)/Alien.mkv",
    ]);
  });

  test("keeps same-titled distinct folders as distinct groups", () => {
    const groups = groupMoviePaths([
      "Collection A/Alien (1979)/a.mkv",
      "Collection B/Alien (1979)/b.mkv",
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.title)).toEqual(["Alien", "Alien"]);
    expect(groups[0]?.canonicalFolder).not.toBe(groups[1]?.canonicalFolder);
  });

  test("skips extras, store paths, traversal and unsupported files", () => {
    const groups = groupMoviePaths([
      "Alien (1979)/Alien.1979.2160p.mkv",
      "Alien (1979)/extras/making-of.mkv",
      "Alien (1979)/Alien-trailer.mkv",
      "Alien (1979)/.pendia/cover.mkv",
      "Alien (1979)/file.mkv.pendia/init.mp4",
      "Alien (1979)/Alien.srt",
      "loose.mkv",
      "../escape/Alien (1979)/Alien.mkv",
      "/absolute/Alien (1979)/Alien.mkv",
    ]);
    expect(groups).toEqual([
      {
        canonicalFolder: "Alien (1979)",
        title: "Alien",
        year: 1979,
        providerIds: {},
        paths: ["Alien (1979)/Alien.1979.2160p.mkv"],
      },
    ]);
  });

  test("groups a main film beside its trailer under an ambiguous title", () => {
    const groups = groupMoviePaths([
      "The Interview (2014)/The Interview.mkv",
      "The Interview (2014)/The Interview-trailer.mkv",
      "The Interview (2014)/The Interview.sample.mkv",
    ]);
    expect(groups).toEqual([
      {
        canonicalFolder: "The Interview (2014)",
        title: "The Interview",
        year: 2014,
        providerIds: {},
        paths: ["The Interview (2014)/The Interview.mkv"],
      },
    ]);
  });

  test("keeps an extras-named top folder beside real nested extras", () => {
    const groups = groupMoviePaths([
      "Shorts/Shorts.mkv",
      "Shorts/extras/making-of.mkv",
      "Alien (1979)/shorts/clip.mkv",
    ]);
    expect(groups).toEqual([
      {
        canonicalFolder: "Shorts",
        title: "Shorts",
        year: null,
        providerIds: {},
        paths: ["Shorts/Shorts.mkv"],
      },
    ]);
  });

  test("deduplicates repeated paths and sorts output", () => {
    const groups = groupMoviePaths([
      "B Movie (2000)/b.mkv",
      "A Movie (1999)/a.mkv",
      "B Movie (2000)/b.mkv",
      "B Movie (2000)/a.mkv",
    ]);
    expect(groups.map((group) => group.canonicalFolder)).toEqual([
      "A Movie (1999)",
      "B Movie (2000)",
    ]);
    expect(groups[1]?.paths).toEqual([
      "B Movie (2000)/a.mkv",
      "B Movie (2000)/b.mkv",
    ]);
  });
});
