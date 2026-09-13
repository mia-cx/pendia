import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { radarrChanges, sonarrChanges } from "./servarr.ts";

async function loadFixture(name: string): Promise<unknown> {
  const text = await readFile(
    join(import.meta.dir, "fixtures", "servarr", name),
    "utf8",
  );
  const payload: unknown = JSON.parse(text);
  return payload;
}

const sonarrProviderIds = {
  tvdb: "366972",
  tmdb: "106379",
  imdb: "tt0804484",
};

const radarrProviderIds = {
  tmdb: "348",
  imdb: "tt0078748",
};

describe("sonarr webhook changes", () => {
  test("download adds the episode file then deletes the upgraded file", async () => {
    expect(sonarrChanges(await loadFixture("sonarr-download.json"))).toEqual([
      {
        kind: "add",
        path: "/media/shows/Foundation/Season 1/Foundation - S01E01 - The Emperor's Peace [WEBDL-1080p].mkv",
        providerIds: sonarrProviderIds,
      },
      {
        kind: "delete",
        path: "/media/shows/Foundation/Season 1/Foundation - S01E01 - The Emperor's Peace [HDTV-720p].mkv",
        target: "file",
        providerIds: sonarrProviderIds,
      },
    ]);
  });

  test("rename emits one move per renamed file keeping previousPath", async () => {
    expect(sonarrChanges(await loadFixture("sonarr-rename.json"))).toEqual([
      {
        kind: "move",
        path: "/media/shows/Foundation/Season 1/Foundation - S01E01 - The Emperor's Peace [WEBDL-1080p].mkv",
        previousPath:
          "/media/shows/Foundation/Season 1/Foundation.S01E01.1080p.ATVP.WEB-DL-NTb.mkv",
        providerIds: sonarrProviderIds,
      },
      {
        kind: "move",
        path: "/media/shows/Foundation/Season 1/Foundation - S01E02 - Preparing to Live [WEBDL-1080p].mkv",
        previousPath:
          "/media/shows/Foundation/Season 1/Foundation.S01E02.1080p.ATVP.WEB-DL-NTb.mkv",
        providerIds: sonarrProviderIds,
      },
    ]);
  });

  test("episode file delete targets the file", async () => {
    expect(sonarrChanges(await loadFixture("sonarr-file-delete.json"))).toEqual(
      [
        {
          kind: "delete",
          path: "/media/shows/Foundation/Season 1/Foundation - S01E03 - The Mathematician's Ghost [WEBDL-1080p].mkv",
          target: "file",
          providerIds: sonarrProviderIds,
        },
      ],
    );
  });

  test("series delete targets the item folder", async () => {
    expect(sonarrChanges(await loadFixture("sonarr-item-delete.json"))).toEqual(
      [
        {
          kind: "delete",
          path: "/media/shows/Foundation",
          target: "item",
          providerIds: sonarrProviderIds,
        },
      ],
    );
  });
});

describe("radarr webhook changes", () => {
  test("download adds the movie file then deletes the upgraded file", async () => {
    expect(radarrChanges(await loadFixture("radarr-download.json"))).toEqual([
      {
        kind: "add",
        path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
        providerIds: radarrProviderIds,
      },
      {
        kind: "delete",
        path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [WEBDL-720p].mkv",
        target: "file",
        providerIds: radarrProviderIds,
      },
    ]);
  });

  test("rename emits one move per renamed file keeping previousPath", async () => {
    expect(radarrChanges(await loadFixture("radarr-rename.json"))).toEqual([
      {
        kind: "move",
        path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
        previousPath:
          "/media/movies/Alien (1979) {tmdb-348}/Alien.1979.1080p.BluRay.x264-FGT.mkv",
        providerIds: radarrProviderIds,
      },
    ]);
  });

  test("movie file delete targets the file", async () => {
    expect(radarrChanges(await loadFixture("radarr-file-delete.json"))).toEqual(
      [
        {
          kind: "delete",
          path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [WEBDL-1080p].mkv",
          target: "file",
          providerIds: radarrProviderIds,
        },
      ],
    );
  });

  test("movie delete targets the item folder", async () => {
    expect(radarrChanges(await loadFixture("radarr-item-delete.json"))).toEqual(
      [
        {
          kind: "delete",
          path: "/media/movies/Alien (1979) {tmdb-348}",
          target: "item",
          providerIds: radarrProviderIds,
        },
      ],
    );
  });
});

describe("webhook change guards", () => {
  test("unknown event types produce no changes", () => {
    expect(sonarrChanges({ eventType: "Test" })).toEqual([]);
    expect(sonarrChanges({ eventType: "Grab" })).toEqual([]);
    expect(sonarrChanges({})).toEqual([]);
    expect(sonarrChanges(null)).toEqual([]);
    expect(sonarrChanges("Download")).toEqual([]);
    expect(radarrChanges({ eventType: "HealthIssue" })).toEqual([]);
    expect(radarrChanges(undefined)).toEqual([]);
  });

  test("malformed recognized payloads throw the provider error", () => {
    expect(() => sonarrChanges({ eventType: "Download" })).toThrow(
      "Invalid Sonarr webhook payload.",
    );
    expect(() =>
      sonarrChanges({
        eventType: "Download",
        series: { path: "/media/shows/Foundation" },
        episodeFile: { path: 42 },
      }),
    ).toThrow("Invalid Sonarr webhook payload.");
    expect(() =>
      sonarrChanges({ eventType: "Rename", series: { path: "/x" } }),
    ).toThrow("Invalid Sonarr webhook payload.");
    expect(() =>
      sonarrChanges({ eventType: "SeriesDelete", series: {} }),
    ).toThrow("Invalid Sonarr webhook payload.");
    expect(() => radarrChanges({ eventType: "Download" })).toThrow(
      "Invalid Radarr webhook payload.",
    );
    expect(() =>
      radarrChanges({
        eventType: "MovieFileDelete",
        movie: { folderPath: "/media/movies/x" },
      }),
    ).toThrow("Invalid Radarr webhook payload.");
    expect(() =>
      radarrChanges({ eventType: "MovieDelete", movie: {} }),
    ).toThrow("Invalid Radarr webhook payload.");
  });

  test("zero and empty provider ids are omitted and numerics become strings", () => {
    expect(
      sonarrChanges({
        eventType: "SeriesDelete",
        series: {
          path: "/media/shows/Gone",
          tvdbId: 0,
          tmdbId: "",
          imdbId: "  ",
          tvMazeId: 99,
        },
      }),
    ).toEqual([
      {
        kind: "delete",
        path: "/media/shows/Gone",
        target: "item",
        providerIds: { imdb: "  " },
      },
    ]);
    expect(
      radarrChanges({
        eventType: "MovieDelete",
        movie: { folderPath: "/media/movies/Gone", tmdbId: 12, imdbId: "" },
      }),
    ).toEqual([
      {
        kind: "delete",
        path: "/media/movies/Gone",
        target: "item",
        providerIds: { tmdb: "12" },
      },
    ]);
  });
});
