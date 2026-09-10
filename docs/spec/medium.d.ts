/**
 * What a medium hands the core. Mediums are in-tree modules, one per medium,
 * behind this interface. Movies and shows are two mediums over a shared
 * video-common module.
 */

export type CoreShelf = "continue-watching" | "recently-added" | "recently-played";

export interface Medium {
  id: string;
  /** Item kinds this medium owns, with the Drizzle schema fragment each adds. */
  kinds: MediumKind[];
  scan: ScanRules;
  /** Provider types this medium consumes. */
  providers: ("metadata" | "subtitles" | "artwork")[];
  formats: ("video" | "audio" | "ebook" | "image")[];
  browse: BrowseContribution;
  /** The translation layer this medium exposes, if any. */
  translation?: { protocol: "jellyfin" | "opensubsonic" | "opds" | "hdhomerun" };
}

export interface MediumKind {
  kind: string;
  /** Kind of a valid parent, or null for a root of the tree. */
  parent: string | null;
  /** Extra columns for this kind, as a Drizzle table keyed on item id. */
  table: unknown;
  /** Whether Items of this kind carry Versions, or are containers. */
  hasVersions: boolean;
}

export interface ScanRules {
  /** Does this path inside a library belong to this medium, and as what? */
  identify(path: string): { kind: string; canonicalFolder: string } | null;
  /** Pull title, year, season and episode numbers out of a canonical folder. */
  parse(canonicalFolder: string): Record<string, unknown>;
  /** Paths inside a canonical folder that are not Versions: extras, trailers, samples. */
  isExtra(path: string): boolean;
}

export interface BrowseContribution {
  /** Which core shelves this medium's Items appear in. */
  coreShelves: CoreShelf[];
  /** Shelves only this medium can compute, such as next up. */
  shelves: { id: string; title: string; items(context: { userId: string }): Promise<string[]> }[];
  /** Client route per kind, such as a show page and a season page. */
  screens: Record<string, string>;
}
