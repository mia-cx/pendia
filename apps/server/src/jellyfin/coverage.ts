import type { ApiOperation } from "./openapi.ts";

/** These tag groups need real core adapters. Each later stack layer removes its explicit gap group. */
export const gaps: Record<string, string> = {
  System: "Complete server identity and configuration defaults.",
  Authentication: "Complete local auth, API keys, and Quick Connect fixtures.",
  User: "Read and update real users and preferences.",
  UserView: "Real views and grouping options.",
  Device: "Read real devices and session revocation.",
  DisplayPreference: "Persist per-user display preferences.",
  Session: "Read sessions and exercise playback reports.",
  Library:
    "Complete browse, latest, counts, ancestors, similar, refresh, and file routes.",
  LibraryStructure: "Adapt core library management.",
  Show: "Complete show browsing and upcoming episodes.",
  Filter: "Read real library facets.",
  Genre: "Read real genre facets.",
  Person: "Read real credits where present.",
  Studio: "Read real studios where present.",
  Year: "Read real years.",
  Search: "Return real search hints.",
  Movie: "Recommend from available movies.",
  Suggestion: "Suggest available items.",
  ItemUpdate: "Adapt core metadata updates.",
  ItemLookup: "Adapt core metadata lookup where supported.",
  Image: "Exercise real artwork and HEAD/image aliases.",
  MediaInfo: "Exercise GET/POST playback info and bitrate test.",
  UserData: "Complete progress and rating adapters.",
  Video: "Exercise real files and HEAD/container aliases.",
  Subtitle: "Exercise real subtitle streams and management where supported.",
  RemoteImage: "Adapt real artwork lookup where supported.",
};

/** A visible gap is never silently counted as neutral coverage. */
export function gapOf(operation: ApiOperation) {
  return operation.tags
    .map((tag) => gaps[tag])
    .find((reason) => reason !== undefined);
}
