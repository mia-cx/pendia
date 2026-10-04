import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "@pendia/plugin-api";
import { migrateDatabase } from "../db/migrate.ts";
import { files, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { addRoot, insertLibraries } from "../libraries/testing.ts";
import { createHost, createRegistrations } from "./host.ts";
import {
  createPluginRuntime,
  PluginFailed,
  PluginUnavailable,
} from "./runtime.ts";
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

describe("host fetch", () => {
  function fetcher(network: string[]) {
    const reached: string[] = [];
    const host = createHost({
      db: {} as never,
      name: "fetcher",
      capabilities: new Set(["network"]),
      network,
      registrations: createRegistrations(),
      config: async () => ({}),
      filesAllowed: async () => true,
      schedule: () => ({ cancel() {} }),
      fetch: (async (url: URL) => {
        reached.push(String(url));
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    if (host.fetch === undefined) throw new Error("fetch missing");
    return { fetch: host.fetch, reached };
  }

  test("reaches only listed hosts, or any host with *", async () => {
    const listed = fetcher(["radarr.example"]);
    await listed.fetch("https://radarr.example/api");
    await expect(listed.fetch("https://other.example/")).rejects.toThrow(
      "may not reach other.example",
    );
    const any = fetcher(["*"]);
    await any.fetch("http://hooks.example:8080/in");
    expect([...listed.reached, ...any.reached]).toEqual([
      "https://radarr.example/api",
      "http://hooks.example:8080/in",
    ]);
  });

  test("refuses schemes other than http and https", async () => {
    const any = fetcher(["*"]);
    await expect(any.fetch("file:///etc/passwd")).rejects.toThrow(
      "only fetch http and https",
    );
    expect(any.reached).toEqual([]);
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
        const [library] = await insertLibraries(db, {
          name: "Movies",
          medium: "movies",
          rootPath: root,
        });
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
        const outsideFile = join(folder, "outside", "keep.txt");
        await Bun.write(outsideFile, "keep");
        await symlink(join(folder, "outside"), join(root, "linked"));
        await symlink(outsideFile, join(root, "keep.txt"));
        const outsideNew = join(folder, "outside", "new.txt");
        await symlink(outsideNew, join(root, "dangling.txt"));
        for (const path of [
          "linked/keep.txt",
          "keep.txt",
          "linked/new.txt",
          "dangling.txt",
        ]) {
          await expect(files.read(library.id, path)).rejects.toThrow(
            "outside the library",
          );
          await expect(
            files.write(library.id, path, new Uint8Array([1])),
          ).rejects.toThrow("outside the library");
          await expect(files.delete(library.id, path)).rejects.toThrow(
            "outside the library",
          );
        }
        expect(await Bun.file(outsideFile).text()).toBe("keep");
        expect(await Bun.file(outsideNew).exists()).toBe(false);
        await files.write(library.id, "Extras/new.txt", new Uint8Array([1]));
        expect(await Bun.file(join(root, "Extras/new.txt")).bytes()).toEqual(
          new Uint8Array([1]),
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

  test("a root id reads the file in that root only", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const name = `filer-${Bun.randomUUIDv7()}`;
        await installFixture(db, folder, {
          name,
          capabilities: ["files", "items:read"],
          source: stashingSource(name),
        });
        const rootA = join(folder, "a");
        const rootB = join(folder, "b");
        await mkdir(join(rootA, "Movie"), { recursive: true });
        await mkdir(join(rootB, "Movie"), { recursive: true });
        await Bun.write(join(rootA, "Movie", "Movie.mkv"), "from a");
        await Bun.write(join(rootB, "Movie", "Movie.mkv"), "from b");
        const [library] = await insertLibraries(db, {
          name: "Movies",
          medium: "movies",
          rootPath: rootA,
        });
        if (!library) throw new Error("Library missing.");
        const rootBId = await addRoot(db, library.id, rootB);
        const item = await insertItem(db, {
          libraryId: library.id,
          kind: "movie",
          title: "Alien",
          year: 1979,
          canonicalFolder: "Movie",
          extension: {},
        });
        const [version] = await db
          .insert(versions)
          .values({
            itemId: item.id,
            itemKind: "movie",
            libraryId: library.id,
            label: "Alien",
            format: "video",
            bytes: 1n,
          })
          .returning();
        if (!version) throw new Error("Version missing.");
        for (const [order, rootId] of [library.rootId, rootBId].entries())
          await db.insert(files).values({
            versionId: version.id,
            itemId: item.id,
            libraryId: library.id,
            rootId,
            path: "Movie/Movie.mkv",
            order,
            bytes: 1n,
            modifiedAt: new Date(0),
          });
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "installed"),
        });
        await runtime.load(name);
        const host = stashedHosts()[name];
        if (!host?.files) throw new Error("files should be present.");
        const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
        expect(text(await host.files.read(rootBId, "Movie/Movie.mkv"))).toBe(
          "from b",
        );
        expect(text(await host.files.read(library.id, "Movie/Movie.mkv"))).toBe(
          "from a",
        );
        const got = await host.items?.get(item.id);
        expect(
          got?.versions[0]?.files.map((file) => file.rootId).sort(),
        ).toEqual([library.rootId, rootBId].sort());
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
        const [library] = await insertLibraries(db, {
          name: "Movies",
          medium: "movies",
          rootPath: folder,
        });
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

  test("a failed setup stops its schedules, and an old cancel leaves its replacement", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const jobs: { stopped: boolean; stop(): void }[] = [];
        const cron = () => {
          const job = {
            stopped: false,
            stop() {
              job.stopped = true;
            },
          };
          jobs.push(job);
          return job;
        };
        const thrower = `cron-thrower-${Bun.randomUUIDv7()}`;
        const twice = `cron-twice-${Bun.randomUUIDv7()}`;
        await installFixture(db, folder, {
          name: thrower,
          capabilities: ["jobs"],
          source: `export default (host) => {
  host.jobs.schedule("sweep", "* * * * *", async () => {});
  throw new Error("setup broke");
};`,
        });
        await installFixture(db, folder, {
          name: twice,
          capabilities: ["jobs"],
          source: `export default (host) => {
  const first = host.jobs.schedule("sweep", "* * * * *", async () => {});
  host.jobs.schedule("sweep", "* * * * *", async () => {});
  first.cancel();
};`,
        });
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "installed"),
          schedules: true,
          cron,
        });
        expect(await runtime.load(thrower)).toBe(false);
        expect(jobs.map((job) => job.stopped)).toEqual([true]);
        expect(await runtime.load(twice)).toBe(true);
        expect(jobs.map((job) => job.stopped)).toEqual([true, true, false]);
        await runtime.stop();
        await Bun.sleep(0);
        expect(jobs.map((job) => job.stopped)).toEqual([true, true, true]);
      }),
    ));

  test("an event for a plugin this process cannot install fails its job and leaves the plugin enabled", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const name = `unreachable-${Bun.randomUUIDv7()}`;
        await installFixture(db, folder, {
          name,
          capabilities: ["events"],
          source: "export default () => {};",
        });
        await rm(join(folder, "sources"), { recursive: true });
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "fresh"),
        });
        await expect(
          runtime.runJob({
            type: "plugin",
            pluginName: name,
            jobId: "event:item.added",
            data: { itemId: Bun.randomUUIDv7(), kind: "movie" },
          }),
        ).rejects.toBeInstanceOf(PluginUnavailable);
        expect((await readPluginSettings(db)).plugins[name]).toMatchObject({
          enabled: true,
          failure: null,
        });
      }),
    ));
});
