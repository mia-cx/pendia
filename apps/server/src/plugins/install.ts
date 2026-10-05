import type { Dirent } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { pluginLockfile } from "../db/schema/index.ts";
import { readBoundedBytes } from "../metadata/bounded-body.ts";
import { PluginError } from "./errors.ts";
import { type PluginPackage, readPluginPackage } from "./manifest.ts";
import { type PluginSettings, updatePluginSettings } from "./settings.ts";

/** A plugin package read from its source, not yet installed. */
export type FetchedPlugin = {
  /** The source pinned to what was fetched: an npm spec carries its exact version. */
  source: string;
  /** SRI sha512 of the tarball, or of the canonical file listing for a folder. */
  integrity: string;
  package: PluginPackage;
  files: Map<string, Uint8Array>;
};

/** Where sources are fetched from; tests point these at local servers. */
export type SourceOptions = {
  fetch?: typeof fetch;
  npmRegistry?: string;
};

/** A row of the lockfile: one installed plugin. */
export type LockedPlugin = typeof pluginLockfile.$inferSelect;

const maxPackageBytes = 64 * 1024 * 1024;
const maxPackumentBytes = 32 * 1024 * 1024;
const skippedFolders = new Set(["node_modules", ".git"]);
const defaultNpmRegistry = "https://registry.npmjs.org";
// An npm spec: an optionally scoped name and an optional version, range or tag.
const npmSpecPattern = /^((?:@[^/@\s]+\/)?[^/@\s]+)(?:@(\S+))?$/;

/** The folder this process installs plugins into. */
export function pluginDirectory(): string {
  return Bun.env.PENDIA_PLUGIN_DIR ?? join(tmpdir(), "pendia-plugins");
}

function sha512(bytes: Uint8Array | string, encoding: "base64" | "hex") {
  return new Bun.CryptoHasher("sha512").update(bytes).digest(encoding);
}

function folderIntegrity(files: Map<string, Uint8Array>): string {
  const listing = [...files.keys()]
    .sort()
    .map((path) => `${path}\0${sha512(files.get(path) ?? "", "hex")}\n`)
    .join("");
  return `sha512-${sha512(listing, "base64")}`;
}

async function readFolder(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  async function walk(relative: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      throw new PluginError("NOT_FOUND", `${root} is not a readable folder.`);
    }
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skippedFolders.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        files.set(path, await Bun.file(join(root, path)).bytes());
      }
    }
  }
  await walk("");
  return files;
}

async function download(
  url: string,
  request: typeof fetch,
  maxBytes: number,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await request(url);
  } catch {
    throw new PluginError("BAD_REQUEST", `${url} could not be reached.`);
  }
  if (!response.ok || response.body === null)
    throw new PluginError("BAD_REQUEST", `${url} answered ${response.status}.`);
  return readBoundedBytes(
    response.body,
    maxBytes,
    () => new PluginError("BAD_REQUEST", `${url} is larger than allowed.`),
  );
}

async function unpack(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  let entries: Map<string, File>;
  try {
    entries = await new Bun.Archive(bytes).files();
  } catch {
    throw new PluginError("BAD_REQUEST", "The package is not a tarball.");
  }
  const files = new Map<string, Uint8Array>();
  let top: string | undefined;
  for (const [path, file] of entries) {
    const normalized = posix.normalize(path);
    if (posix.isAbsolute(normalized) || normalized.split("/").includes(".."))
      throw new PluginError("BAD_REQUEST", `${path} escapes the package.`);
    // A package tarball holds one top folder, `package/` for npm.
    const [folder = "", ...rest] = normalized.split("/");
    top ??= folder;
    if (folder !== top)
      throw new PluginError(
        "BAD_REQUEST",
        "The package holds more than one top folder.",
      );
    const inner = rest.join("/");
    if (inner !== "") files.set(inner, await file.bytes());
  }
  return files;
}

type NpmVersion = { dist?: { tarball?: unknown; integrity?: unknown } };

async function resolveNpm(
  spec: string,
  registry: string,
  request: typeof fetch,
): Promise<{
  name: string;
  version: string;
  tarball: string;
  integrity: unknown;
}> {
  const match = npmSpecPattern.exec(spec);
  const name = match?.[1];
  if (name === undefined)
    throw new PluginError(
      "BAD_REQUEST",
      "Enter an absolute folder path, a tarball URL or an npm package name.",
    );
  const wanted = match?.[2] ?? "latest";
  const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`;
  const packument: {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, NpmVersion>;
  } = JSON.parse(
    new TextDecoder().decode(await download(url, request, maxPackumentBytes)),
  );
  const versions = Object.keys(packument.versions ?? {});
  const version =
    packument["dist-tags"]?.[wanted] ??
    versions
      .filter((candidate) => Bun.semver.satisfies(candidate, wanted))
      .sort(Bun.semver.order)
      .at(-1);
  const dist =
    version === undefined ? undefined : packument.versions?.[version]?.dist;
  if (version === undefined || typeof dist?.tarball !== "string")
    throw new PluginError("NOT_FOUND", `npm has no ${name}@${wanted}.`);
  return { name, version, tarball: dist.tarball, integrity: dist.integrity };
}

/** Reads a plugin from an absolute folder path, an http(s) tarball URL or an npm spec. */
export async function fetchPlugin(
  source: string,
  {
    fetch: request = fetch,
    npmRegistry = Bun.env.PENDIA_NPM_REGISTRY ?? defaultNpmRegistry,
  }: SourceOptions = {},
): Promise<FetchedPlugin> {
  const trimmed = source.trim();
  let pinned = trimmed;
  let files: Map<string, Uint8Array>;
  let integrity: string;
  let npmName: string | undefined;
  if (isAbsolute(trimmed)) {
    files = await readFolder(trimmed);
    integrity = folderIntegrity(files);
  } else if (/^https?:\/\//i.test(trimmed)) {
    const bytes = await download(trimmed, request, maxPackageBytes);
    integrity = `sha512-${sha512(bytes, "base64")}`;
    files = await unpack(bytes);
  } else {
    const resolved = await resolveNpm(trimmed, npmRegistry, request);
    const bytes = await download(resolved.tarball, request, maxPackageBytes);
    integrity = `sha512-${sha512(bytes, "base64")}`;
    if (
      typeof resolved.integrity === "string" &&
      resolved.integrity.startsWith("sha512-") &&
      resolved.integrity !== integrity
    )
      throw new PluginError(
        "CONFLICT",
        `The ${resolved.name}@${resolved.version} tarball does not match npm's integrity.`,
      );
    files = await unpack(bytes);
    pinned = `${resolved.name}@${resolved.version}`;
    npmName = resolved.name;
  }
  const manifest = files.get("package.json");
  if (manifest === undefined)
    throw new PluginError("BAD_REQUEST", "The package has no package.json.");
  let read: PluginPackage;
  try {
    read = readPluginPackage(JSON.parse(new TextDecoder().decode(manifest)));
  } catch (error) {
    throw new PluginError(
      "BAD_REQUEST",
      error instanceof SyntaxError
        ? "The package.json is not valid JSON."
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
  if (npmName !== undefined && read.name !== npmName)
    throw new PluginError(
      "BAD_REQUEST",
      `npm served ${read.name} for ${npmName}.`,
    );
  if (!files.has(read.manifest.entry))
    throw new PluginError(
      "BAD_REQUEST",
      `The entry ${read.manifest.entry} is missing from the package.`,
    );
  return { source: pinned, integrity, package: read, files };
}

/** The folder a package with this integrity installs into, so two versions never share one. */
export function installedRoot(directory: string, integrity: string): string {
  const key = new Bun.CryptoHasher("sha256")
    .update(integrity)
    .digest("hex")
    .slice(0, 32);
  return join(directory, key);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Writes a fetched plugin into the plugin folder atomically and returns its root. */
export async function installFiles(
  directory: string,
  plugin: FetchedPlugin,
): Promise<string> {
  const root = installedRoot(directory, plugin.integrity);
  if (await exists(root)) return root;
  const staging = join(directory, `.staging-${Bun.randomUUIDv7()}`);
  try {
    for (const [path, bytes] of plugin.files)
      await Bun.write(join(staging, path), bytes);
    await rename(staging, root).catch(async (error: unknown) => {
      // Another process on this host installed the same integrity first.
      if (!(await exists(root))) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return root;
}

/** Installs a locked plugin into this process's folder when missing, refetching it and checking the locked integrity. */
export async function ensureInstalled(
  directory: string,
  locked: LockedPlugin,
  options?: SourceOptions,
): Promise<string> {
  const root = installedRoot(directory, locked.integrity);
  if (await exists(root)) return root;
  const fetched = await fetchPlugin(locked.source, options);
  if (fetched.integrity !== locked.integrity)
    throw new PluginError(
      "CONFLICT",
      `${locked.source} no longer matches the lockfile integrity of ${locked.name}.`,
    );
  return installFiles(directory, fetched);
}

/**
 * Installs a previewed plugin. The package must still have the previewed
 * integrity, which is what makes its manifest's capabilities the approved ones.
 * The lockfile row and the enabled state are written together.
 */
export async function installPlugin(
  db: Database,
  directory: string,
  source: string,
  integrity: string,
  options?: SourceOptions,
): Promise<FetchedPlugin> {
  const fetched = await fetchPlugin(source, options);
  if (fetched.integrity !== integrity)
    throw new PluginError(
      "CONFLICT",
      "The package changed since the preview. Preview it again.",
    );
  await installFiles(directory, fetched);
  const { name, version, manifest } = fetched.package;
  await updatePluginSettings(db, async (current, tx) => {
    const locked = { version, source: fetched.source, integrity };
    await tx
      .insert(pluginLockfile)
      .values({ name, ...locked })
      .onConflictDoUpdate({ target: pluginLockfile.name, set: locked });
    const previous = current.plugins[name];
    return {
      ...current,
      plugins: {
        ...current.plugins,
        [name]: {
          capabilities: manifest.capabilities,
          enabled: true,
          failure: null,
          filesOff: previous?.filesOff ?? null,
          config: previous?.config ?? {},
        },
      },
    };
  });
  return fetched;
}

/** Removes an installed plugin: its lockfile row and its settings entry go together; the folder stays for the content-addressed cache. */
export async function removePlugin(
  db: Database,
  name: string,
): Promise<PluginSettings> {
  return updatePluginSettings(db, async (current, tx) => {
    const state = current.plugins[name];
    if (state === undefined)
      throw new PluginError("NOT_FOUND", `${name} is not installed.`);
    await tx.delete(pluginLockfile).where(eq(pluginLockfile.name, name));
    const { [name]: _removed, ...plugins } = current.plugins;
    return { ...current, plugins };
  });
}
