import type { Database } from "../db/client.ts";
import { readBoundedBytes } from "../metadata/bounded-body.ts";
import { PluginError } from "./install.ts";
import { updatePluginSettings } from "./settings.ts";

/** A plugin a registry lists, with the versions it offers and where each comes from. */
export type RegistryEntry = {
  name: string;
  description: string | null;
  versions: { version: string; source: string }[];
};

const registryFile = "pendia-registry.json";
const maxRegistryBytes = 4 * 1024 * 1024;

function httpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PluginError("BAD_REQUEST", `${value} is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new PluginError("BAD_REQUEST", `${value} is not an http(s) URL.`);
  return url;
}

/** Maps a registry URL to its manifest: a GitHub repo serves `pendia-registry.json` at its root. */
export function registryManifestUrl(registry: string): string {
  const url = httpUrl(registry);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "github.com" && owner && repo)
    return `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, "")}/HEAD/${registryFile}`;
  if (url.pathname.endsWith(".json")) return url.href;
  return new URL(
    registryFile,
    url.href.endsWith("/") ? url.href : `${url.href}/`,
  ).href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads a registry manifest: `{ plugins: [{ name, description?, versions: [{ version, source }] }] }`. */
export function readRegistry(json: unknown): RegistryEntry[] {
  const invalid = (): never => {
    throw new PluginError("BAD_REQUEST", "The registry manifest is invalid.");
  };
  if (!isRecord(json) || !Array.isArray(json.plugins)) return invalid();
  return json.plugins.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string") return invalid();
    const { description = null, versions } = entry;
    if (description !== null && typeof description !== "string")
      return invalid();
    if (!Array.isArray(versions)) return invalid();
    return {
      name: entry.name,
      description,
      versions: versions.map((version: unknown) =>
        isRecord(version) &&
        typeof version.version === "string" &&
        typeof version.source === "string"
          ? { version: version.version, source: version.source }
          : invalid(),
      ),
    };
  });
}

/** Fetches and reads one registry's manifest. */
export async function fetchRegistry(
  registry: string,
  request: typeof fetch = fetch,
): Promise<RegistryEntry[]> {
  const url = registryManifestUrl(registry);
  let response: Response;
  try {
    response = await request(url);
  } catch {
    throw new PluginError("BAD_REQUEST", `${url} could not be reached.`);
  }
  if (!response.ok || response.body === null)
    throw new PluginError("BAD_REQUEST", `${url} answered ${response.status}.`);
  const bytes = await readBoundedBytes(
    response.body,
    maxRegistryBytes,
    () => new PluginError("BAD_REQUEST", `${url} is larger than allowed.`),
  );
  try {
    return readRegistry(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("BAD_REQUEST", `${url} is not JSON.`);
  }
}

/** Adds a registry URL once. */
export async function addRegistry(db: Database, registry: string) {
  const url = httpUrl(registry.trim()).href;
  return updatePluginSettings(db, (current) => ({
    ...current,
    registries: current.registries.includes(url)
      ? current.registries
      : [...current.registries, url],
  }));
}

/** Removes a registry URL. */
export async function removeRegistry(db: Database, registry: string) {
  return updatePluginSettings(db, (current) => ({
    ...current,
    registries: current.registries.filter((url) => url !== registry),
  }));
}
