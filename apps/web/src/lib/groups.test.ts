import { expect, test } from "bun:test";
import { cacheSavedGroup } from "./groups.ts";

type Row = { id: string; permissions: string[] };

test("a failed refresh keeps the saved permissions for the next edit", async () => {
  const server = new Map<string, string[]>([
    ["g1", ["view"]],
    ["g2", ["manage-metadata"]],
  ]);
  const rows = () =>
    [...server.entries()].map(([id, permissions]) => ({
      id,
      permissions: [...permissions],
    }));
  const setPermissions = async (id: string, permissions: string[]) => {
    server.set(id, permissions);
    return { id, permissions };
  };

  let failing = false;
  const list = {
    data: rows() as readonly Row[] | undefined,
    set(value: readonly Row[]) {
      this.data = value;
    },
    async reload() {
      if (!failing) this.data = rows();
    },
  };

  failing = true;

  const first = list.data?.find((row) => row.id === "g1");
  expect(first).toBeDefined();
  const saved1 = await setPermissions("g1", [
    ...(first?.permissions ?? []),
    "manage-metadata",
  ]);
  await cacheSavedGroup(list, saved1);

  const second = list.data?.find((row) => row.id === "g1");
  const saved2 = await setPermissions("g1", [
    ...(second?.permissions ?? []),
    "manage-subtitles",
  ]);
  await cacheSavedGroup(list, saved2);

  expect(server.get("g1")).toEqual([
    "view",
    "manage-metadata",
    "manage-subtitles",
  ]);
  expect(list.data?.find((row) => row.id === "g2")?.permissions).toEqual([
    "manage-metadata",
  ]);
});
