import { describe, expect, test } from "bun:test";
import {
  namesOneTitle,
  normalizeTitle,
  parseRelease,
  parseTitle,
  sameTitle,
  titleKey,
} from "./titles.ts";

describe("parseTitle", () => {
  test.each([
    ["The Expanse (2015)", { title: "The Expanse", year: 2015 }],
    ["The Expanse", { title: "The Expanse", year: null }],
    ["The.Expanse (2015)", { title: "The Expanse", year: 2015 }],
    ["Dr. Strangelove (1964)", { title: "Dr. Strangelove", year: 1964 }],
    ["Dr.Strangelove (1964)", { title: "Dr Strangelove", year: 1964 }],
    ["Alien (1979) {tmdb-348}", { title: "Alien", year: 1979 }],
    ["Alien (1979) {imdb-tt0078748}", { title: "Alien", year: 1979 }],
    ["Alien (1979) [tmdbid-348]", { title: "Alien", year: 1979 }],
    ["Alien (1979) {TVDB=123} {tmdb-}", { title: "Alien", year: 1979 }],
  ])("parses %s", (name, expected) => {
    expect(parseTitle(name)).toEqual(expected);
  });
});

describe("parseRelease", () => {
  test.each([
    ["Dune.2021.1080p.BluRay.x264-GROUP", { title: "Dune", year: 2021 }],
    [
      "Blade.Runner.2049.2017.2160p.UHD.BluRay",
      { title: "Blade Runner 2049", year: 2017 },
    ],
    [
      "2001.A.Space.Odyssey.1968.1080p",
      { title: "2001 A Space Odyssey", year: 1968 },
    ],
    [
      "The Matrix (1999) [tmdbid-603] - [Remux-2160p] - FraMeSToR",
      { title: "The Matrix", year: 1999 },
    ],
    ["Arrival 2016 WEB-DL DDP5.1 H.264", { title: "Arrival", year: 2016 }],
    ["Home Video", { title: "Home Video", year: null }],
    [
      "Spider-Man.No.Way.Home.2021.2160p",
      { title: "Spider-Man No Way Home", year: 2021 },
    ],
    ["Alien.1979.2160p", { title: "Alien", year: 1979 }],
    ["Alien", { title: "Alien", year: null }],
    ["The.Matrix.1999.2160p", { title: "The Matrix", year: 1999 }],
    [
      "Movie.2020.REMUX.2160p.HDR10.DTS-HD.MA.TrueHD.Atmos.7.1.x265-GRP",
      { title: "Movie", year: 2020 },
    ],
    ["Title.2019.1080p.WEBRip.AAC2.0.x264", { title: "Title", year: 2019 }],
    [
      "Some Show.2018.INTERNAL.720p.HDTV.x264",
      { title: "Some Show", year: 2018 },
    ],
    ["Arrival (2016)", { title: "Arrival", year: 2016 }],
    ["Movie One (2020) - 2160p", { title: "Movie One", year: 2020 }],
    ["abc123", { title: "abc123", year: null }],
  ])("parses %s", (stem, expected) => {
    expect(parseRelease(stem)).toEqual(expected);
  });
});

describe("normalizeTitle", () => {
  test.each([
    ["Breaking.Bad", "breaking bad"],
    ["Breaking Bad", "breaking bad"],
    ["Amélie", "amelie"],
    ["Don't Look Up", "dont look up"],
    ["Don’t Look Up", "dont look up"],
    ["Spider-Man: No Way Home!", "spider man no way home"],
    ["  Alien   (1979)  ", "alien 1979"],
  ])("normalizes %s", (title, expected) => {
    expect(normalizeTitle(title)).toBe(expected);
  });
});

describe("titleKey", () => {
  test.each([
    ["Breaking Bad", 2008, "breaking bad (2008)"],
    ["Breaking Bad", null, "breaking bad"],
    ["Dune", 2021, "dune (2021)"],
  ])("keys %s", (title, year, expected) => {
    expect(titleKey(title, year)).toBe(expected);
  });
});

describe("sameTitle", () => {
  test.each([
    ["Doctor Who", "Doctor Who", true],
    ["Doctor Who", "Doctor Who 2005", true],
    ["Doctor Who 2005", "Doctor Who", true],
    ["Breaking Bad", "Breaking.Bad", true],
    ["Dune", "Movies", false],
    ["The Wire", "Breaking Bad", false],
  ])("compares %s and %s", (a, b, expected) => {
    expect(sameTitle(a, b)).toBe(expected);
  });
});

describe("namesOneTitle", () => {
  test.each([
    ["Alien (1979)", true],
    ["Alien (1979) [tmdbid-348]", true],
    ["Movie [tmdbid-202]", true],
    ["Movie {tmdb-348}", true],
    ["Movies", false],
    ["TV", false],
    ["hq", false],
  ])("checks %s", (name, expected) => {
    expect(namesOneTitle(name)).toBe(expected);
  });
});
