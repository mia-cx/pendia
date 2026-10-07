import { expect, test } from "bun:test";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchedChange } from "../libraries/webhooks.ts";
import { watchTree } from "./tree.ts";

/** Watches a fresh tree under `base`, runs `act` on its root, and returns what it reported. */
async function watchWhile(
  base: string,
  setup: (root: string) => Promise<void>,
  act: (root: string) => Promise<void>,
  expected: number,
) {
  const root = join(base, "root");
  await mkdir(root);
  await setup(root);
  const seen: WatchedChange[] = [];
  const tree = await watchTree(root, (changes) => seen.push(...changes), {
    settleMs: 20,
  });
  try {
    await act(root);
    const deadline = Date.now() + 1_000;
    while (seen.length < expected && Date.now() < deadline) await Bun.sleep(10);
    await Bun.sleep(100);
    return seen;
  } finally {
    tree.close();
  }
}

async function withBase(run: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "thalia-tree-"));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("a file replaced by a directory is reported as deleted", () =>
  withBase(async (base) => {
    const seen = await watchWhile(
      base,
      (root) => writeFile(join(root, "Alien.mkv"), "frames"),
      async (root) => {
        await rm(join(root, "Alien.mkv"));
        await mkdir(join(root, "Alien.mkv"));
      },
      1,
    );
    expect(seen).toEqual([{ kind: "delete", path: "Alien.mkv" }]);
  }));

test("files under a directory replaced by a file are reported as deleted", () =>
  withBase(async (base) => {
    const seen = await watchWhile(
      base,
      async (root) => {
        await mkdir(join(root, "Alien (1979)"));
        await writeFile(join(root, "Alien (1979)/Alien.mkv"), "frames");
      },
      async (root) => {
        await rm(join(root, "Alien (1979)"), { recursive: true });
        await writeFile(join(root, "Alien (1979)"), "not a folder");
      },
      2,
    );
    expect(seen).toContainEqual({
      kind: "delete",
      path: "Alien (1979)/Alien.mkv",
    });
  }));

test("a new file on a vanished file's inode is an add, not a move", () =>
  withBase(async (base) => {
    // A link outside the tree keeps the inode alive, as ext4 reuse would.
    const outside = join(base, "outside.mkv");
    const seen = await watchWhile(
      base,
      async (root) => {
        await writeFile(join(root, "Alien.mkv"), "frames");
        await link(join(root, "Alien.mkv"), outside);
      },
      async (root) => {
        await rm(join(root, "Alien.mkv"));
        await appendFile(outside, " and more frames");
        await link(outside, join(root, "Heat.mkv"));
      },
      2,
    );
    expect(seen).toEqual(
      expect.arrayContaining([
        { kind: "add", path: "Heat.mkv" },
        { kind: "delete", path: "Alien.mkv" },
      ]),
    );
    expect(seen).toHaveLength(2);
  }));
