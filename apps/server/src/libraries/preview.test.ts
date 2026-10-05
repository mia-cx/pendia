import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withVideoFixture } from "../mediums/video-common/fixtures.ts";
import { previewScan, type ScanPreviewExample } from "./preview.ts";

const listing = async (dir: string, base = dir): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    paths.push(path.slice(base.length + 1));
    if (entry.isDirectory()) paths.push(...(await listing(path, base)));
  }
  return paths.sort();
};

describe("previewScan", () => {
  test("previews a single show root", () =>
    withVideoFixture(async (dir) => {
      const folder = join(dir, "Breaking Bad (2008)");
      await mkdir(join(folder, "Season 01"), { recursive: true });
      await mkdir(join(folder, "Season 02"));
      await writeFile(
        join(folder, "Season 01", "Breaking.Bad.S01E01.1080p.mkv"),
        "",
      );
      await writeFile(
        join(folder, "Season 01", "Breaking.Bad.S01E02.1080p.mkv"),
        "",
      );
      await writeFile(join(folder, "Season 02", "Breaking.Bad.S02E01.mkv"), "");
      await mkdir(join(folder, "extras"));
      await writeFile(join(folder, "extras", "Making Of.mkv"), "");
      await writeFile(join(folder, "notes.txt"), "");
      expect(await previewScan(folder, "shows")).toEqual({
        counts: { show: 1, season: 2, episode: 3 },
        unrecognised: 0,
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
        reason: null,
      });
    }));

  test("previews a flat movies folder and honours the example limit", () =>
    withVideoFixture(async (dir) => {
      const folder = join(dir, "Movies");
      await mkdir(folder);
      await writeFile(
        join(folder, "Dune.2021.1080p.BluRay.x264-GROUP.mkv"),
        "",
      );
      await writeFile(join(folder, "Arrival.2016.mkv"), "");
      const expected: ScanPreviewExample[] = [
        {
          kind: "movie",
          title: "Arrival",
          year: 2016,
          folder: ".",
          files: 1,
        },
        { kind: "movie", title: "Dune", year: 2021, folder: ".", files: 1 },
      ];
      expect(await previewScan(folder, "movies")).toEqual({
        counts: { movie: 2 },
        unrecognised: 0,
        examples: expected,
        reason: null,
      });
      expect(await previewScan(folder, "movies", { examples: 1 })).toEqual({
        counts: { movie: 2 },
        unrecognised: 0,
        examples: expected.slice(0, 1),
        reason: null,
      });
    }));

  test("reports an unrecognised folder of video files", () =>
    withVideoFixture(async (dir) => {
      const folder = join(dir, "Unsorted");
      await mkdir(join(folder, "Some Show"), { recursive: true });
      await writeFile(join(folder, "Some Show", "clip.mkv"), "");
      expect(await previewScan(folder, "shows")).toEqual({
        counts: { show: 0, season: 0, episode: 0 },
        unrecognised: 1,
        examples: [],
        reason: "unrecognised",
      });
    }));

  test("reports empty folders", () =>
    withVideoFixture(async (dir) => {
      const folder = join(dir, "Empty");
      await mkdir(folder);
      expect(await previewScan(folder, "movies")).toEqual({
        counts: { movie: 0 },
        unrecognised: 0,
        examples: [],
        reason: "empty",
      });
      await writeFile(join(folder, "readme.txt"), "");
      expect(await previewScan(folder, "movies")).toEqual({
        counts: { movie: 0 },
        unrecognised: 0,
        examples: [],
        reason: "empty",
      });
    }));

  test("reports missing and non-folder paths", () =>
    withVideoFixture(async (dir) => {
      expect(await previewScan(join(dir, "missing"), "movies")).toEqual({
        counts: { movie: 0 },
        unrecognised: 0,
        examples: [],
        reason: "missing",
      });
      const file = join(dir, "file.txt");
      await writeFile(file, "");
      expect(await previewScan(file, "shows")).toEqual({
        counts: { show: 0, season: 0, episode: 0 },
        unrecognised: 0,
        examples: [],
        reason: "not-a-folder",
      });
    }));

  test("rejects a relative folder", () =>
    withVideoFixture(async () => {
      await expect(previewScan("relative/folder", "movies")).rejects.toThrow();
    }));

  test("leaves the folder untouched", () =>
    withVideoFixture(async (dir) => {
      const folder = join(dir, "Breaking Bad (2008)");
      await mkdir(join(folder, "Season 01"), { recursive: true });
      await writeFile(join(folder, "Season 01", "Breaking.Bad.S01E01.mkv"), "");
      const before = await listing(folder);
      await previewScan(folder, "shows");
      expect(await listing(folder)).toEqual(before);
    }));
});
