import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { moviesMedium } from "../mediums/movies.ts";
import { withVideoFixture } from "../mediums/video-common/fixtures.ts";
import { type LibraryFile, readLibraryFile, walkLibrary } from "./walker.ts";

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
      await expect(collect(join(root, "missing"))).rejects.toThrow();
      await expect(collect("relative/root")).rejects.toThrow();
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
