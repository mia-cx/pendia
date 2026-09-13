import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { withVideoFixture } from "../mediums/video-common/fixtures.ts";
import {
  type LibraryDirectory,
  type LibraryFile,
  MissingLibraryPathError,
  readLibraryFile,
  walkLibrary,
  walkLibraryDirectories,
} from "./walker.ts";

async function collect(
  root: string,
  options?: { path?: string; recursive?: boolean },
): Promise<LibraryFile[]> {
  const files: LibraryFile[] = [];
  for await (const file of walkLibrary(root, moviesMedium.scan, options)) {
    files.push(file);
  }
  return files;
}

async function populate(root: string) {
  await mkdir(join(root, "Alien (1979)", "extras"), { recursive: true });
  await writeFile(join(root, "Alien (1979)", "Alien.1979.2160p.mkv"), "2160p");
  await writeFile(join(root, "Alien (1979)", "Alien.1979.1080p.mkv"), "1080p");
  await writeFile(
    join(root, "Alien (1979)", "extras", "making-of.mkv"),
    "extra",
  );
  for (const folder of ["Behind.The.Scenes", "Deleted.Scenes"]) {
    await mkdir(join(root, "Alien (1979)", folder));
    await writeFile(join(root, "Alien (1979)", folder, "clip.mkv"), "extra");
  }
  await writeFile(join(root, "Alien (1979)", "Alien-trailer.mkv"), "trailer");
  await mkdir(join(root, "Alien (1979)", "movie.mkv.pendia"));
  await writeFile(
    join(root, "Alien (1979)", "movie.mkv.pendia", "init.mp4"),
    "store",
  );
  await mkdir(join(root, "Alien (1979)", ".pendia"));
  await writeFile(join(root, "Alien (1979)", ".pendia", "art.mp4"), "art");
  await mkdir(join(root, "Collection", "Alien (1979)"), { recursive: true });
  await writeFile(join(root, "Collection", "Alien (1979)", "copy.mkv"), "copy");
  await writeFile(join(root, "loose.mkv"), "loose");
  await writeFile(join(root, "notes.txt"), "notes");
  await symlink("/etc", join(root, "linkdir"));
  await symlink(".", join(root, "cycle"));
  await symlink(
    join("Alien (1979)", "Alien.1979.2160p.mkv"),
    join(root, "linkfile.mkv"),
  );
}

describe("walkLibrary", () => {
  test("yields canonical movie paths and prunes extras and stores", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      const files = await collect(root);
      expect(files.map((file) => file.path)).toEqual([
        "Alien (1979)/Alien.1979.1080p.mkv",
        "Alien (1979)/Alien.1979.2160p.mkv",
        "Collection/Alien (1979)/copy.mkv",
      ]);
      const file = files[0];
      expect(file?.bytes).toBe(5n);
      expect(typeof file?.modifiedNs).toBe("bigint");
      expect(file?.modifiedAt).toBeInstanceOf(Date);
    }));

  test("walks a supplied subtree and a single file", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      expect(
        (await collect(root, { path: "Collection" })).map((file) => file.path),
      ).toEqual(["Collection/Alien (1979)/copy.mkv"]);
      expect(
        (
          await collect(root, {
            path: "Collection/Alien (1979)/copy.mkv",
          })
        ).map((file) => file.path),
      ).toEqual(["Collection/Alien (1979)/copy.mkv"]);
    }));

  test("yields a title-matching file in a top-level extras-named folder", () =>
    withVideoFixture(async (root) => {
      await mkdir(join(root, "Shorts", "extras"), { recursive: true });
      await writeFile(join(root, "Shorts", "Shorts.mkv"), "movie");
      await writeFile(join(root, "Shorts", "extras", "making-of.mkv"), "extra");
      await mkdir(join(root, "extras"));
      await writeFile(join(root, "extras", "clip.mkv"), "extra");
      await mkdir(join(root, ".pendia"));
      await writeFile(join(root, ".pendia", ".pendia.mkv"), "store");
      const files = await collect(root);
      expect(files.map((file) => file.path)).toEqual(["Shorts/Shorts.mkv"]);
      expect(groupMoviePaths(files.map((file) => file.path))).toHaveLength(1);
      expect(
        (await collect(root, { path: "Shorts" })).map((file) => file.path),
      ).toEqual(["Shorts/Shorts.mkv"]);
    }));

  test("groups extras-named movies inside nested collections", () =>
    withVideoFixture(async (root) => {
      await mkdir(join(root, "Collection", "Shorts", "extras"), {
        recursive: true,
      });
      await writeFile(
        join(root, "Collection", "Shorts", "Shorts.mkv"),
        "movie",
      );
      await writeFile(
        join(root, "Collection", "Shorts", "extras", "clip.mkv"),
        "extra",
      );
      await mkdir(join(root, "Alien (1979)", "shorts"), { recursive: true });
      await writeFile(
        join(root, "Alien (1979)", "shorts", "clip.mkv"),
        "extra",
      );
      await mkdir(join(root, "Alien (1979)", "extras", "Shorts"), {
        recursive: true,
      });
      await writeFile(
        join(root, "Alien (1979)", "extras", "Shorts", "Shorts.mkv"),
        "extra",
      );
      await writeFile(
        join(root, "Alien (1979)", "extras", "extras.mkv"),
        "extra",
      );
      await mkdir(join(root, "Collection", ".pendia", "Shorts"), {
        recursive: true,
      });
      await writeFile(
        join(root, "Collection", ".pendia", "Shorts", "Shorts.mkv"),
        "store",
      );
      const files = await collect(root);
      expect(files.map((file) => file.path)).toEqual([
        "Collection/Shorts/Shorts.mkv",
      ]);
      expect(groupMoviePaths(files.map((file) => file.path))).toEqual([
        {
          canonicalFolder: "Collection/Shorts",
          title: "Shorts",
          year: null,
          paths: ["Collection/Shorts/Shorts.mkv"],
        },
      ]);
      expect(
        (
          await collect(root, {
            path: "Collection/Shorts",
            recursive: false,
          })
        ).map((file) => file.path),
      ).toEqual(["Collection/Shorts/Shorts.mkv"]);
    }));

  test("yields nothing inside a supplied extras or store subtree", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      expect(await collect(root, { path: "Alien (1979)/extras" })).toEqual([]);
      expect(await collect(root, { path: "Alien (1979)/.pendia" })).toEqual([]);
      expect(
        await collect(root, { path: "Alien (1979)/movie.mkv.pendia" }),
      ).toEqual([]);
    }));

  test("rejects symlink, absolute and escaping subtree paths", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      await expect(collect(root, { path: "linkdir" })).rejects.toThrow();
      await expect(collect(root, { path: "linkfile.mkv" })).rejects.toThrow();
      await expect(collect(root, { path: "/etc" })).rejects.toThrow();
      await expect(collect(root, { path: "../outside" })).rejects.toThrow();
      await expect(
        collect(root, { path: "Alien (1979)/../loose.mkv" }),
      ).rejects.toThrow();
    }));

  test("throws on a missing or relative root", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      await expect(collect(join(root, "missing"))).rejects.toThrow(
        MissingLibraryPathError,
      );
      await expect(collect("relative/root")).rejects.toThrow();
    }));

  test("throws MissingLibraryPathError for a missing requested subtree", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      await expect(
        collect(root, { path: "Alien (1979)/Gone" }),
      ).rejects.toThrow(MissingLibraryPathError);
      await expect(
        collect(root, { path: "Alien (1979)/gone.mkv" }),
      ).rejects.toThrow(MissingLibraryPathError);
    }));

  test("recursive false lists only direct files of the subtree", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      expect(
        (await collect(root, { path: "Collection", recursive: false })).map(
          (file) => file.path,
        ),
      ).toEqual([]);
      expect(
        (await collect(root, { path: "Alien (1979)", recursive: false })).map(
          (file) => file.path,
        ),
      ).toEqual([
        "Alien (1979)/Alien.1979.1080p.mkv",
        "Alien (1979)/Alien.1979.2160p.mkv",
      ]);
    }));
});

describe("walkLibraryDirectories", () => {
  async function collectDirectories(root: string) {
    const directories: LibraryDirectory[] = [];
    for await (const directory of walkLibraryDirectories(
      root,
      moviesMedium.scan,
    )) {
      directories.push(directory);
    }
    return directories;
  }

  test("yields each directory's mtime and accepted direct files", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      const directories = await collectDirectories(root);
      expect(directories.map((directory) => directory.path)).toEqual([
        ".",
        "Alien (1979)",
        "Alien (1979)/Behind.The.Scenes",
        "Alien (1979)/Deleted.Scenes",
        "Collection",
        "Collection/Alien (1979)",
      ]);
      for (const directory of directories) {
        expect(typeof directory.modifiedNs).toBe("bigint");
      }
      const byPath = new Map(
        directories.map((directory) => [directory.path, directory.files]),
      );
      expect(byPath.get(".")).toEqual([]);
      expect(byPath.get("Alien (1979)")).toEqual([
        "Alien (1979)/Alien.1979.1080p.mkv",
        "Alien (1979)/Alien.1979.2160p.mkv",
      ]);
      expect(byPath.get("Alien (1979)/Behind.The.Scenes")).toEqual([]);
      expect(byPath.get("Alien (1979)/Deleted.Scenes")).toEqual([]);
      expect(byPath.get("Collection")).toEqual([]);
      expect(byPath.get("Collection/Alien (1979)")).toEqual([
        "Collection/Alien (1979)/copy.mkv",
      ]);
    }));

  test("throws MissingLibraryPathError for a missing root", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      await expect(collectDirectories(join(root, "missing"))).rejects.toThrow(
        MissingLibraryPathError,
      );
    }));
});

describe("readLibraryFile", () => {
  test("returns bytes, nanosecond mtime and a Date", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      const file = await readLibraryFile(
        root,
        "Alien (1979)/Alien.1979.2160p.mkv",
      );
      expect(file).toMatchObject({
        path: "Alien (1979)/Alien.1979.2160p.mkv",
        bytes: 5n,
      });
      expect(typeof file.modifiedNs).toBe("bigint");
      expect(file.modifiedAt.getTime()).toBe(
        Number(file.modifiedNs / 1000000n),
      );
    }));

  test("rejects symlinks, directories and escaping paths", () =>
    withVideoFixture(async (root) => {
      await populate(root);
      await expect(readLibraryFile(root, "linkfile.mkv")).rejects.toThrow();
      await expect(readLibraryFile(root, "Alien (1979)")).rejects.toThrow();
      await expect(readLibraryFile(root, "/etc/passwd")).rejects.toThrow();
      await expect(
        readLibraryFile(root, "Alien (1979)/../../etc/passwd"),
      ).rejects.toThrow();
      await expect(readLibraryFile(root, "missing.mkv")).rejects.toThrow();
    }));
});
