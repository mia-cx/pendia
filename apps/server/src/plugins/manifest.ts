import { posix } from "node:path";
import type { Capability } from "@pendia/plugin-api";
import { type ConfigSchema, readConfigSchema } from "./config.ts";

/** The host API version plugins declare a semver range against. */
export const hostApiVersion = "1.0.0";

/** Every capability a manifest may declare. */
export const capabilities = [
  "items:read",
  "items:write",
  "progress:read",
  "providers",
  "shelves",
  "events",
  "jobs",
  "http",
  "network",
  "files",
] as const satisfies readonly Capability[];

// Fails to compile when the published Capability union gains a member this list lacks.
const _exhaustive: Capability extends (typeof capabilities)[number]
  ? true
  : never = true;

/** A plugin package read from its package.json. */
export type PluginPackage = {
  name: string;
  version: string;
  manifest: {
    api: string;
    capabilities: Capability[];
    network: string[];
    config: ConfigSchema | null;
    /** Package-relative path of the entry module, without a leading `./`. */
    entry: string;
  };
};

// npm's rules: lowercase, url-safe, optionally scoped, at most 214 characters.
const namePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const maxNameLength = 214;
const versionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Reports whether `name` is a valid npm package name. */
export function isPackageName(name: string): boolean {
  return name.length <= maxNameLength && namePattern.test(name);
}

/** The network entry that lets a plugin reach any host, such as a webhook URL an admin enters. */
export const anyHost = "*";

function isHostname(value: string): boolean {
  try {
    // URL keeps `*` in a hostname, so `*.example` would pass as a literal host.
    return (
      /^[a-z0-9.:[\]-]+$/.test(value) &&
      new URL(`http://${value}`).hostname === value
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads and validates a plugin's package.json, throwing a readable error on anything invalid. */
export function readPluginPackage(json: unknown): PluginPackage {
  const fail = (reason: string): never => {
    throw new Error(`Invalid plugin package: ${reason}`);
  };
  if (!isRecord(json)) return fail("package.json must be an object.");
  const { name, version, pendia } = json;
  if (typeof name !== "string" || !isPackageName(name))
    return fail("name must be an npm package name.");
  if (typeof version !== "string" || !versionPattern.test(version))
    return fail("version must be a semver version.");
  if (!isRecord(pendia)) return fail("the pendia block is missing.");
  const { api, network = [], config, entry } = pendia;
  if (typeof api !== "string" || api.trim().length === 0)
    return fail("pendia.api must be a semver range.");
  if (!Bun.semver.satisfies(hostApiVersion, api))
    return fail(
      `pendia.api ${api} does not accept host API ${hostApiVersion}.`,
    );
  if (!Array.isArray(pendia.capabilities))
    return fail("pendia.capabilities must be an array.");
  const declared = pendia.capabilities.map((value: unknown) => {
    const known = capabilities.find((capability) => capability === value);
    return known ?? fail(`unknown capability ${String(value)}.`);
  });
  if (declared.includes("items:write") && !declared.includes("items:read"))
    return fail("items:write needs items:read.");
  if (
    !Array.isArray(network) ||
    !network.every(
      (host) =>
        typeof host === "string" && (host === anyHost || isHostname(host)),
    )
  )
    return fail('pendia.network must list lowercase hostnames or "*".');
  if (typeof entry !== "string" || entry.length === 0)
    return fail("pendia.entry must be a path.");
  const normalized = posix.normalize(entry);
  if (
    posix.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    normalized === ".."
  )
    return fail("pendia.entry must stay inside the package.");
  let schema: ConfigSchema | null = null;
  if (config !== undefined) {
    try {
      schema = readConfigSchema(config);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (schema.type !== "object")
      return fail("config must be an object schema.");
  }
  return {
    name,
    version,
    manifest: {
      api,
      capabilities: [...new Set(declared)],
      network: [...new Set(network)],
      config: schema,
      entry: normalized,
    },
  };
}
