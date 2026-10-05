import type { PendiaClient } from "./api.ts";

// Mirrors the server's default registry.
export const officialRegistry = "https://github.com/mia-cx/pendia";

/** An installed plugin as the admin list returns it. */
export type InstalledPlugin = Awaited<
  ReturnType<PendiaClient["plugins"]["list"]>
>["plugins"][number];

/** A registry as the admin list returns it. */
export type Registry = Awaited<
  ReturnType<PendiaClient["registries"]["list"]>
>[number];

/** A plugin one registry entry offers. */
export type RegistryEntry = Registry["entries"][number];

/** A capability a plugin can ask for. */
export type Capability = InstalledPlugin["capabilities"][number];

/** A files switch: null is on, otherwise off for good or until a time. */
export type FilesOff = InstalledPlugin["filesOff"];

const capabilityLabels: Record<Capability, string> = {
  "items:read": "Read your libraries",
  "items:write": "Tag items",
  "progress:read": "Read everyone's watch progress",
  providers: "Supply metadata, artwork or subtitles",
  shelves: "Add shelves to Home and item pages",
  events: "Receive server events",
  jobs: "Run scheduled jobs",
  http: "Serve its own pages under /plugins/",
  network: "Reach the internet",
  files: "Read, change and delete files in your libraries",
};

function describeNetwork(network: readonly string[]): string {
  if (network.includes("*")) return "Reach any host";
  if (network.length > 0) return `Reach ${network.join(", ")}`;
  return capabilityLabels.network;
}

/** Describes what each capability lets a plugin do, naming the hosts network may reach. */
export function describeCapabilities(
  capabilities: readonly Capability[],
  network: readonly string[],
): string[] {
  return capabilities.map((capability) =>
    capability === "network"
      ? describeNetwork(network)
      : capabilityLabels[capability],
  );
}

/** The choices the file access control offers. */
export type FilesChoice = "on" | "until" | "hour" | "day" | "off";

const hourMs = 3_600_000;
const durations = { hour: hourMs, day: 24 * hourMs } as const;

/** Reads a stored switch as the control's current choice; a timed switch that has ended is on. */
export function filesChoice(off: FilesOff, now = Date.now()): FilesChoice {
  if (off === null) return "on";
  if (off.until === null) return "off";
  return Date.parse(off.until) > now ? "until" : "on";
}

/** Turns a chosen option into the switch to store. */
export function filesOffFor(
  choice: Exclude<FilesChoice, "until">,
  now = Date.now(),
): FilesOff {
  if (choice === "on") return null;
  if (choice === "off") return { until: null };
  return { until: new Date(now + durations[choice]).toISOString() };
}

/** Names a registry: the official one reads "Pendia registry", others read their hostname. */
export function registryLabel(url: string): string {
  if (url === officialRegistry) return "Pendia registry";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Names where a plugin's source came from: its registry, a local folder, a URL host or npm. */
export function pluginOrigin(
  source: string,
  registries: readonly Registry[],
): string {
  for (const registry of registries) {
    for (const entry of registry.entries) {
      if (entry.versions.some((version) => version.source === source))
        return registryLabel(registry.url);
    }
  }
  if (source.startsWith("/")) return "Local folder";
  try {
    return new URL(source).hostname;
  } catch {
    return "npm";
  }
}

/** What the Available row's action for an entry is: install, update an installed version, or already installed. */
export function entryAction(
  entry: RegistryEntry,
  plugins: readonly InstalledPlugin[],
): "install" | "update" | "installed" {
  const installed = plugins.find((plugin) => plugin.name === entry.name);
  if (installed === undefined) return "install";
  return installed.version === entry.versions[0]?.version
    ? "installed"
    : "update";
}
