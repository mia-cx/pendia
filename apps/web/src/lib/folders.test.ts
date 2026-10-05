import { describe, expect, test } from "bun:test";
import {
  canChoose,
  crumbs,
  describePreview,
  type FolderPreview,
  normaliseFolder,
  overlapping,
  parentFolder,
} from "./folders.ts";

describe("crumbs", () => {
  test("splits a path into breadcrumb entries, root first", () => {
    expect(crumbs("/srv/media/films")).toEqual([
      { name: "/", path: "/" },
      { name: "srv", path: "/srv" },
      { name: "media", path: "/srv/media" },
      { name: "films", path: "/srv/media/films" },
    ]);
    expect(crumbs("/")).toEqual([{ name: "/", path: "/" }]);
  });
});

describe("normaliseFolder", () => {
  test("collapses slashes and drops a trailing slash, keeping /", () => {
    expect(normaliseFolder("/srv//media/")).toBe("/srv/media");
    expect(normaliseFolder("//srv///media")).toBe("/srv/media");
    expect(normaliseFolder("/")).toBe("/");
    expect(normaliseFolder("///")).toBe("/");
    expect(normaliseFolder("/srv/media")).toBe("/srv/media");
    expect(normaliseFolder("relative/path/")).toBe("relative/path/");
  });
});

describe("parentFolder", () => {
  test("answers the parent path, / for /", () => {
    expect(parentFolder("/srv/media")).toBe("/srv");
    expect(parentFolder("/srv")).toBe("/");
    expect(parentFolder("/")).toBe("/");
    expect(parentFolder("/srv/media/")).toBe("/srv");
  });
});

describe("overlapping", () => {
  test("equal or nested paths overlap", () => {
    expect(overlapping("/srv/movies", ["/srv/movies"])).toBe(true);
    expect(overlapping("/srv", ["/srv/movies"])).toBe(true);
    expect(overlapping("/srv/movies/kids", ["/srv/movies"])).toBe(true);
  });

  test("sibling and prefix-sharing paths do not", () => {
    expect(overlapping("/srv/movies", ["/srv/shows"])).toBe(false);
    expect(overlapping("/srv/movies2", ["/srv/movies"])).toBe(false);
    expect(overlapping("/srv", [])).toBe(false);
  });
});

const movies = (
  counts: { movie: number },
  over: Partial<FolderPreview> = {},
): FolderPreview => ({
  counts,
  unrecognised: 0,
  examples: [],
  reason: null,
  ...over,
});

const shows = (
  counts: { show: number; season: number; episode: number },
  over: Partial<FolderPreview> = {},
): FolderPreview => ({
  counts,
  unrecognised: 0,
  examples: [],
  reason: null,
  ...over,
});

describe("describePreview", () => {
  test("names found movies and shows", () => {
    expect(describePreview(movies({ movie: 1 }), "movies").headline).toBe(
      "1 movie",
    );
    expect(describePreview(movies({ movie: 12 }), "movies").headline).toBe(
      "12 movies",
    );
    const found = describePreview(
      shows({ show: 1, season: 1, episode: 1 }),
      "shows",
    );
    expect(found.headline).toBe("1 show");
    expect(found.detail).toBe("1 season, 1 episode");
    const many = describePreview(
      shows({ show: 12, season: 3, episode: 40 }),
      "shows",
    );
    expect(many.headline).toBe("12 shows");
    expect(many.detail).toBe("3 seasons, 40 episodes");
  });

  test("movies carry no detail line unless videos are unrecognised", () => {
    expect(describePreview(movies({ movie: 3 }), "movies").detail).toBeNull();
    expect(
      describePreview(movies({ movie: 3 }, { unrecognised: 1 }), "movies")
        .detail,
    ).toBe("1 video wasn't recognised");
    expect(
      describePreview(
        shows({ show: 2, season: 3, episode: 40 }, { unrecognised: 2 }),
        "shows",
      ).detail,
    ).toBe("3 seasons, 40 episodes · 2 videos weren't recognised");
  });

  test("reads an empty, unrecognised, missing or non-folder preview", () => {
    const empty = describePreview(
      movies({ movie: 0 }, { reason: "empty" }),
      "movies",
    );
    expect(empty.headline).toBe("Nothing to scan here");
    expect(empty.detail).toBe("This folder has no videos.");

    const noMovies = describePreview(
      movies({ movie: 0 }, { reason: "unrecognised", unrecognised: 4 }),
      "movies",
    );
    expect(noMovies.headline).toBe("No movies recognised");
    expect(noMovies.detail).toBe(
      "Name each movie like Title (Year), in its own folder or on its own.",
    );
    const noShows = describePreview(
      shows(
        { show: 0, season: 0, episode: 0 },
        { reason: "unrecognised", unrecognised: 4 },
      ),
      "shows",
    );
    expect(noShows.headline).toBe("No shows recognised");
    expect(noShows.detail).toBe(
      "Name episodes like Show/Season 01/Show S01E01.",
    );

    expect(
      describePreview(movies({ movie: 0 }, { reason: "missing" }), "movies"),
    ).toMatchObject({ headline: "This folder doesn't exist", detail: null });
    expect(
      describePreview(
        movies({ movie: 0 }, { reason: "not-a-folder" }),
        "movies",
      ),
    ).toMatchObject({ headline: "This is a file, not a folder", detail: null });
  });

  test("describes example rows", () => {
    const found = describePreview(
      movies(
        { movie: 2 },
        {
          examples: [
            {
              kind: "movie",
              title: "Dune",
              year: 2021,
              folder: ".",
              files: 1,
            },
            {
              kind: "movie",
              title: "Alien",
              year: null,
              folder: ".",
              files: 2,
            },
          ],
        },
      ),
      "movies",
    );
    expect(found.examples).toEqual([
      { title: "Dune (2021)", caption: null },
      { title: "Alien", caption: "2 versions" },
    ]);

    const show = describePreview(
      shows(
        { show: 1, season: 2, episode: 3 },
        {
          examples: [
            {
              kind: "show",
              title: "Breaking Bad",
              year: 2008,
              folder: ".",
              seasons: [1, 2],
              episodes: 3,
            },
          ],
        },
      ),
      "shows",
    );
    expect(show.examples).toEqual([
      { title: "Breaking Bad (2008)", caption: "2 seasons, 3 episodes" },
    ]);
  });
});

describe("canChoose", () => {
  test("blocks an overlap and every listing failure but a missing path", () => {
    expect(canChoose({ overlapped: true })).toBe(false);
    expect(canChoose({ overlapped: false })).toBe(true);
    expect(canChoose({ overlapped: false, listingCode: "NOT_FOUND" })).toBe(
      true,
    );
    for (const listingCode of ["FORBIDDEN", "BAD_REQUEST", "UNREACHABLE"]) {
      expect(canChoose({ overlapped: false, listingCode })).toBe(false);
    }
  });

  test("blocks a missing or not-a-folder preview", () => {
    expect(canChoose({ overlapped: false, reason: "missing" })).toBe(false);
    expect(canChoose({ overlapped: false, reason: "not-a-folder" })).toBe(
      false,
    );
    expect(canChoose({ overlapped: false, reason: "empty" })).toBe(true);
    expect(
      canChoose({ overlapped: false, listingCode: "NOT_FOUND", reason: null }),
    ).toBe(true);
  });
});
