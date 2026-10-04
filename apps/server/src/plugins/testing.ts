import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, PluginHost } from "@pendia/plugin-api";
import type { Database } from "../db/client.ts";
import { fetchPlugin, installPlugin } from "./install.ts";

/** A fixture plugin: its package.json fields and the source of its entry module. */
export type FixturePlugin = {
  name: string;
  version?: string;
  capabilities?: Capability[];
  network?: string[];
  config?: object;
  /** The entry module; it default-exports the setup function. */
  source: string;
};

/** The files of a fixture plugin, keyed by package-relative path. */
export function fixtureFiles(plugin: FixturePlugin): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: plugin.name,
      version: plugin.version ?? "1.0.0",
      pendia: {
        api: "^1.0.0",
        capabilities: plugin.capabilities ?? [],
        network: plugin.network,
        config: plugin.config,
        entry: "./index.js",
      },
    }),
    "index.js": plugin.source,
  };
}

/** Packs a fixture plugin as an npm-style gzipped tarball under `package/`. */
export async function fixtureTarball(plugin: FixturePlugin) {
  const files = Object.fromEntries(
    Object.entries(fixtureFiles(plugin)).map(([path, text]) => [
      `package/${path}`,
      text,
    ]),
  );
  return new Bun.Archive(files, { compress: "gzip" }).bytes();
}

/** Runs a test with a fresh temporary folder that is removed afterwards. */
export async function withFolder(run: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "pendia-plugin-test-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Writes a fixture plugin into `folder` and returns that folder. */
export async function writeFixture(folder: string, plugin: FixturePlugin) {
  for (const [path, text] of Object.entries(fixtureFiles(plugin)))
    await Bun.write(join(folder, path), text);
  return folder;
}

/** Installs a fixture plugin from a folder under `folder`, as an admin would after the preview. */
export async function installFixture(
  db: Database,
  folder: string,
  plugin: FixturePlugin,
) {
  const source = await writeFixture(
    join(folder, "sources", plugin.name),
    plugin,
  );
  const { integrity } = await fetchPlugin(source);
  return installPlugin(db, join(folder, "installed"), source, integrity);
}

/** The hosts fixture plugins stash on globalThis so tests can inspect them. */
export function stashedHosts(): Record<string, PluginHost> {
  globalThis.pendiaHosts ??= {};
  return globalThis.pendiaHosts;
}

declare global {
  var pendiaHosts: Record<string, PluginHost> | undefined;
}

/** A fixture entry that stashes its host under `key` and then runs `body`. */
export function stashingSource(key: string, body = "") {
  return `export default async (host) => {
  globalThis.pendiaHosts ??= {};
  globalThis.pendiaHosts[${JSON.stringify(key)}] = host;
  ${body}
};`;
}
