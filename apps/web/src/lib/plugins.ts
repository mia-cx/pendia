import type { PendiaClient } from "./api.ts";

/** An installed plugin as the admin list returns it. */
export type InstalledPlugin = Awaited<
  ReturnType<PendiaClient["plugins"]["list"]>
>["plugins"][number];

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
