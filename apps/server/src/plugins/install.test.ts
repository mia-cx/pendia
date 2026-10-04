import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { migrateDatabase } from "../db/migrate.ts";
import { pluginLockfile } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  ensureInstalled,
  fetchPlugin,
  installedRoot,
  installFiles,
  installPlugin,
} from "./install.ts";
import {
  fetchRegistry,
  readRegistry,
  registryManifestUrl,
} from "./registries.ts";
import { readPluginSettings } from "./settings.ts";
import {
  type FixturePlugin,
  fixtureTarball,
  withFolder,
  writeFixture,
} from "./testing.ts";

const hello: FixturePlugin = {
  name: "pendia-plugin-hello",
  capabilities: ["items:read", "files"],
  source: "export default () => {};",
};

function sri(bytes: Uint8Array) {
  return `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
}

/** Serves tarballs, an npm packument and a registry manifest from one local server. */
async function withPackageServer(
  run: (origin: string, tarball: Uint8Array) => Promise<void>,
) {
  const tarball = await fixtureTarball(hello);
  const evil = await new Bun.Archive(
    { "package/../../evil.js": "x" },
    { compress: "gzip" },
  ).bytes();
  const twoTops = await new Bun.Archive(
    { "package/index.js": "export default () => {};", "other/index.js": "x" },
    { compress: "gzip" },
  ).bytes();
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { origin, pathname } = new URL(request.url);
      if (pathname === "/hello.tgz") return new Response(tarball);
      if (pathname === "/evil.tgz") return new Response(evil);
      if (pathname === "/two.tgz") return new Response(twoTops);
      if (pathname === "/npm/pendia-plugin-hello")
        return Response.json({
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "0.9.0": { dist: { tarball: `${origin}/missing.tgz` } },
            "1.0.0": {
              dist: { tarball: `${origin}/hello.tgz`, integrity: sri(tarball) },
            },
          },
        });
      if (pathname === "/registry/pendia-registry.json")
        return Response.json({
          plugins: [
            {
              name: "pendia-plugin-hello",
              description: "Says hello.",
              versions: [{ version: "1.0.0", source: `${origin}/hello.tgz` }],
            },
          ],
        });
      return new Response("missing", { status: 404 });
    },
  });
  try {
    await run(`http://127.0.0.1:${server.port}`, tarball);
  } finally {
    await server.stop(true);
  }
}

describe("plugin sources", () => {
  test("reads a folder with a stable integrity that tracks its content", () =>
    withFolder(async (folder) => {
      await writeFixture(folder, hello);
      await Bun.write(join(folder, "node_modules/dep/index.js"), "ignored");
      const first = await fetchPlugin(folder);
      expect(first.source).toBe(folder);
      expect(first.package.name).toBe("pendia-plugin-hello");
      expect([...first.files.keys()].sort()).toEqual([
        "index.js",
        "package.json",
      ]);
      expect((await fetchPlugin(folder)).integrity).toBe(first.integrity);
      await Bun.write(join(folder, "index.js"), "export default () => 1;");
      expect((await fetchPlugin(folder)).integrity).not.toBe(first.integrity);
    }));

  test("reads a tarball URL, stripping the package folder", () =>
    withPackageServer(async (origin, tarball) => {
      const fetched = await fetchPlugin(`${origin}/hello.tgz`);
      expect(fetched.integrity).toBe(sri(tarball));
      expect(fetched.package.manifest.capabilities).toEqual([
        "items:read",
        "files",
      ]);
      expect([...fetched.files.keys()].sort()).toEqual([
        "index.js",
        "package.json",
      ]);
    }));

  test("resolves an npm spec through the registry and pins its version", () =>
    withPackageServer(async (origin, tarball) => {
      const options = { npmRegistry: `${origin}/npm` };
      const latest = await fetchPlugin("pendia-plugin-hello", options);
      expect(latest.source).toBe("pendia-plugin-hello@1.0.0");
      expect(latest.integrity).toBe(sri(tarball));
      const ranged = await fetchPlugin("pendia-plugin-hello@^1", options);
      expect(ranged.source).toBe("pendia-plugin-hello@1.0.0");
      await expect(
        fetchPlugin("pendia-plugin-hello@^2", options),
      ).rejects.toThrow("npm has no pendia-plugin-hello@^2.");
    }));

  test("rejects a tarball entry that escapes the package", () =>
    withPackageServer(async (origin) => {
      await expect(fetchPlugin(`${origin}/evil.tgz`)).rejects.toThrow(
        "escapes the package",
      );
      await expect(fetchPlugin(`${origin}/two.tgz`)).rejects.toThrow(
        "more than one top folder",
      );
    }));

  test("rejects a source with an invalid manifest", () =>
    withFolder(async (folder) => {
      await writeFixture(folder, { ...hello, capabilities: ["items:write"] });
      await expect(fetchPlugin(folder)).rejects.toThrow(
        "items:write needs items:read",
      );
    }));

  test("installs atomically into a folder keyed by integrity", () =>
    withFolder(async (folder) => {
      const source = await writeFixture(join(folder, "source"), hello);
      const fetched = await fetchPlugin(source);
      const directory = join(folder, "plugins");
      const root = await installFiles(directory, fetched);
      expect(root).toBe(installedRoot(directory, fetched.integrity));
      expect(await Bun.file(join(root, "index.js")).text()).toBe(hello.source);
      expect(await installFiles(directory, fetched)).toBe(root);
      expect(await readdir(directory)).toHaveLength(1);
    }));
});

describe("registries", () => {
  test("maps a GitHub repo to the manifest at its root", () => {
    expect(registryManifestUrl("https://github.com/mia-cx/pendia")).toBe(
      "https://raw.githubusercontent.com/mia-cx/pendia/HEAD/pendia-registry.json",
    );
    expect(registryManifestUrl("https://plugins.example/")).toBe(
      "https://plugins.example/pendia-registry.json",
    );
    expect(registryManifestUrl("https://plugins.example/list.json")).toBe(
      "https://plugins.example/list.json",
    );
    expect(() => registryManifestUrl("ftp://x")).toThrow("not an http(s) URL");
  });

  test("reads a registry manifest and rejects a malformed one", () =>
    withPackageServer(async (origin) => {
      expect(await fetchRegistry(`${origin}/registry`)).toEqual([
        {
          name: "pendia-plugin-hello",
          description: "Says hello.",
          versions: [{ version: "1.0.0", source: `${origin}/hello.tgz` }],
        },
      ]);
      expect(() => readRegistry({ plugins: [{ name: 1 }] })).toThrow(
        "The registry manifest is invalid.",
      );
    }));
});

describe.skipIf(!databaseUrl)("lockfile", () => {
  test("installs from a registry entry, then a fresh folder reinstalls from the lockfile", () =>
    withPackageServer((origin, tarball) =>
      withFolder((folder) =>
        withDatabase(async (db) => {
          await migrateDatabase(db);
          const [entry] = await fetchRegistry(`${origin}/registry`);
          const source = entry?.versions[0]?.source ?? "";
          const preview = await fetchPlugin(source);
          await installPlugin(
            db,
            join(folder, "first"),
            source,
            preview.integrity,
          );
          const [locked] = await db.select().from(pluginLockfile);
          expect(locked).toMatchObject({
            name: "pendia-plugin-hello",
            version: "1.0.0",
            source,
            integrity: sri(tarball),
          });
          expect(
            (await readPluginSettings(db)).plugins["pendia-plugin-hello"],
          ).toEqual({
            capabilities: ["items:read", "files"],
            enabled: true,
            failure: null,
            filesOff: null,
            config: {},
          });
          if (!locked) throw new Error("Lockfile row missing.");
          const root = await ensureInstalled(join(folder, "fresh"), locked);
          expect(await Bun.file(join(root, "index.js")).text()).toBe(
            hello.source,
          );
        }),
      ),
    ));

  test("refuses a source that changed since the preview or the lockfile", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const source = await writeFixture(join(folder, "source"), hello);
        const { integrity } = await fetchPlugin(source);
        await installPlugin(db, join(folder, "a"), source, integrity);
        await Bun.write(join(source, "index.js"), "export default () => 2;");
        await expect(
          installPlugin(db, join(folder, "b"), source, integrity),
        ).rejects.toThrow("changed since the preview");
        const [locked] = await db.select().from(pluginLockfile);
        if (!locked) throw new Error("Lockfile row missing.");
        await expect(
          ensureInstalled(join(folder, "c"), locked),
        ).rejects.toThrow("no longer matches the lockfile");
      }),
    ));
});
