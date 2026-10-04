import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Capability } from "@pendia/plugin-api";
import { migrateDatabase } from "../db/migrate.ts";
import { libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { createHost, createRegistrations } from "./host.ts";
import { createPluginRuntime, PluginFailed } from "./runtime.ts";
import { readPluginSettings, updatePluginSettings } from "./settings.ts";
import {
  installFixture,
  stashedHosts,
  stashingSource,
  withFolder,
} from "./testing.ts";

const optional = [
  "items",
  "progress",
  "files",
  "providers",
  "shelves",
  "events",
  "jobs",
  "http",
  "fetch",
] as const;

function present(capabilities: Capability[]) {
  const host = createHost({
    db: {} as never,
    name: "gated",
    capabilities: new Set(capabilities),
    network: [],
    registrations: createRegistrations(),
    config: async () => ({}),
    filesAllowed: async () => true,
    schedule: () => ({ cancel() {} }),
    fetch,
  });
  return {
    members: optional.filter((member) => member in host),
    setTags: host.items !== undefined && "setTags" in host.items,
  };
}

describe("host gating", () => {
  test("a capability the plugin lacks is an absent member", () => {
    expect(present([])).toEqual({ members: [], setTags: false });
    expect(present(["items:read", "files"])).toEqual({
      members: ["items", "files"],
      setTags: false,
    });
    expect(present(["items:read", "items:write"]).setTags).toBe(true);
    expect(
      present([
        "items:read",
        "progress:read",
        "providers",
        "shelves",
        "events",
        "jobs",
        "http",
        "network",
        "files",
      ]).members,
    ).toEqual([...optional]);
  });
});

describe.skipIf(!databaseUrl)("plugin runtime", () => {
  test("files is absent without the capability, present with it, and gone at the global switch", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const plain = `plain-${Bun.randomUUIDv7()}`;
        const filer = `filer-${Bun.randomUUIDv7()}`;
        await installFixture(db, folder, {
          name: plain,
          capabilities: ["items:read"],
          source: stashingSource(plain),
        });
        await installFixture(db, folder, {
          name: filer,
          capabilities: ["files"],
          source: stashingSource(filer),
        });
        const root = join(folder, "library");
        await Bun.write(join(root, "movie.mkv"), "frames");
        const [library] = await db
          .insert(libraries)
          .values({ name: "Movies", medium: "movies", rootPath: root })
          .returning();
        if (!library) throw new Error("Library missing.");
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "installed"),
        });

        expect(await runtime.load(plain)).toBe(true);
        expect(stashedHosts()[plain]?.files).toBeUndefined();
        expect(stashedHosts()[plain]?.items).toBeDefined();

        expect(await runtime.load(filer)).toBe(true);
        const files = stashedHosts()[filer]?.files;
        if (!files) throw new Error("files should be present.");
        expect(await files.stat(library.id, "movie.mkv")).toMatchObject({
          bytes: 6,
        });
        await expect(files.stat(library.id, "../escape")).rejects.toThrow(
          "outside the library",
        );

        await updatePluginSettings(db, (current) => ({
          ...current,
          filesOff: { until: null },
        }));
        await expect(files.stat(library.id, "movie.mkv")).rejects.toThrow(
          "File access is switched off",
        );
        await runtime.sync();
        expect(await runtime.load(filer)).toBe(true);
        expect(stashedHosts()[filer]?.files).toBeUndefined();
      }),
    ));

  test("a throwing setup marks the plugin failed and keeps it unloaded", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const name = `thrower-${Bun.randomUUIDv7()}`;
        await installFixture(db, folder, {
          name,
          source: 'export default () => { throw new Error("boom"); };',
        });
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "installed"),
        });
        expect(await runtime.load(name)).toBe(false);
        const state = (await readPluginSettings(db)).plugins[name];
        expect(state).toMatchObject({
          enabled: false,
          failure: { message: "boom" },
        });
        expect(await runtime.load(name)).toBe(false);
      }),
    ));

  test("a provider result that is not plain data fails the plugin", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const name = `leaky-${Bun.randomUUIDv7()}`;
        await installFixture(db, folder, {
          name,
          capabilities: ["providers"],
          source: `export default (host) => host.providers.metadata({
  id: "leaky",
  kinds: ["movie"],
  search: async () => [{ providerId: "1", title: "A", year: null, confidence: 1, handle: () => 1 }],
  fetch: async () => null,
});`,
        });
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "installed"),
        });
        const [provider] = await runtime.metadataProviders();
        expect(provider?.id).toBe("leaky");
        const search = provider?.search({ title: "A", kind: "movie" });
        await expect(search).rejects.toBeInstanceOf(PluginFailed);
        await expect(search).rejects.toThrow("result[0].handle is a function");
        expect((await readPluginSettings(db)).plugins[name]?.enabled).toBe(
          false,
        );
        expect(await runtime.metadataProviders()).toEqual([]);
      }),
    ));

  test("items reach the plugin with their library id", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const name = `reader-${Bun.randomUUIDv7()}`;
        await installFixture(db, folder, {
          name,
          capabilities: ["items:read"],
          source: stashingSource(name),
        });
        const [library] = await db
          .insert(libraries)
          .values({ name: "Movies", medium: "movies", rootPath: folder })
          .returning();
        if (!library) throw new Error("Library missing.");
        const item = await insertItem(db, {
          libraryId: library.id,
          kind: "movie",
          title: "Alien",
          year: 1979,
          canonicalFolder: "Alien (1979)",
          extension: {},
        });
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "installed"),
        });
        await runtime.load(name);
        const host = stashedHosts()[name];
        expect(await host?.items?.get(item.id)).toMatchObject({
          id: item.id,
          libraryId: library.id,
          kind: "movie",
          title: "Alien",
          versions: [],
        });
        const page = await host?.items?.query({ kind: ["movie"], limit: 1 });
        expect(page?.items.map((found) => found.id)).toEqual([item.id]);
        await expect(host?.items?.query({ limit: 0 })).rejects.toThrow(
          "query.limit",
        );
      }),
    ));
});
