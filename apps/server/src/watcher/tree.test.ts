import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchedChange } from "../libraries/webhooks.ts";
import { watchTree } from "./tree.ts";

test("a file replaced by a directory is reported as deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pendia-tree-"));
  await writeFile(join(root, "Alien.mkv"), "frames");
  const seen: WatchedChange[] = [];
  const tree = await watchTree(root, (changes) => seen.push(...changes), {
    settleMs: 20,
  });
  try {
    await rm(join(root, "Alien.mkv"));
    await mkdir(join(root, "Alien.mkv"));
    const deadline = Date.now() + 1_000;
    while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(seen).toEqual([{ kind: "delete", path: "Alien.mkv" }]);
  } finally {
    tree.close();
    await rm(root, { recursive: true, force: true });
  }
});
