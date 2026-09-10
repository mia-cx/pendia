/**
 * Pendia plugin API, version 1.
 *
 * A plugin exports `definePlugin(setup)`. Pendia calls `setup` once with a
 * PluginHost built for that plugin: a capability the plugin did not declare,
 * or the admin switched off, is absent from the object.
 *
 * Every value crossing this boundary is JSON-serialisable and every call
 * returns a plain Promise. That is what keeps a later move to a subprocess a
 * host change rather than a plugin rewrite, and it keeps Effect out of plugin
 * code.
 */

export type Capability =
  | "items:read"
  | "items:write"
  | "progress:read"
  | "providers"
  | "shelves"
  | "events"
  | "jobs"
  | "http"
  | "network"
  | "files";

export type ItemKind = "movie" | "show" | "season" | "episode";

export interface PluginManifest {
  /** Semver range of the host API this plugin was written against. */
  api: string;
  capabilities: Capability[];
  /** Hosts this plugin may reach with `host.fetch`. */
  network?: string[];
  /** JSON Schema for `host.config`, rendered as the plugin's settings form. */
  config?: object;
  entry: string;
}

export interface Item {
  id: string;
  kind: ItemKind;
  parentId: string | null;
  title: string;
  year: number | null;
  providerIds: Record<string, string>;
  addedAt: string;
  versions: Version[];
}

export interface Version {
  id: string;
  label: string;
  format: "video" | "audio" | "ebook" | "image";
  bytes: number;
  durationSeconds: number | null;
  files: { path: string; bytes: number }[];
}

export interface ItemQuery {
  kind?: ItemKind[];
  libraryId?: string;
  addedBefore?: string;
  parentId?: string;
  limit?: number;
  cursor?: string;
}

export interface Progress {
  userId: string;
  positionSeconds: number;
  completed: boolean;
  playedAt: string | null;
  playCount: number;
}

export interface PluginHost {
  readonly api: string;
  readonly log: {
    info(message: string, data?: object): void;
    warn(message: string, data?: object): void;
    error(message: string, data?: object): void;
  };

  /** Present with "items:read". */
  readonly items?: {
    query(query: ItemQuery): Promise<{ items: Item[]; cursor: string | null }>;
    get(id: string): Promise<Item | null>;
    /** Present with "items:write". Tags and plugin-owned fields only. */
    setTags?(id: string, tags: string[]): Promise<void>;
  };

  /** Present with "progress:read". Every user's progress for one Item. */
  readonly progress?: {
    forItem(itemId: string): Promise<Progress[]>;
  };

  /**
   * Present with "files", which the admin approves at install behind a warning
   * and can switch off per plugin or globally, temporarily or for good. Paths
   * are library-relative. There are no file handles: a plugin asks Pendia to
   * act on a path.
   */
  readonly files?: {
    stat(path: string): Promise<{ bytes: number; modifiedAt: string } | null>;
    read(path: string, range?: { offset: number; length: number }): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array): Promise<void>;
    delete(path: string): Promise<void>;
  };

  /** Present with "providers". */
  readonly providers?: {
    metadata(provider: MetadataProvider): void;
    subtitles(provider: SubtitleProvider): void;
    artwork(provider: ArtworkProvider): void;
  };

  /** Present with "shelves". A shelf appears on the home screen or an Item page. */
  readonly shelves?: {
    register(shelf: {
      id: string;
      title: string;
      placement: "home" | "item";
      items(context: { userId: string; itemId?: string }): Promise<string[]>;
    }): void;
  };

  /** Present with "events". */
  readonly events?: {
    on<E extends keyof PluginEvents>(event: E, handler: (payload: PluginEvents[E]) => Promise<void>): void;
  };

  /** Present with "jobs". */
  readonly jobs?: {
    schedule(id: string, cron: string, handler: () => Promise<void>): { cancel(): void };
  };

  /** Present with "http". Routes are served under /plugins/<id>/. */
  readonly http?: {
    route(method: "GET" | "POST", path: string, handler: (request: PluginRequest) => Promise<PluginResponse>): void;
  };

  /** Present with "network". Restricted to the manifest's host list. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;

  readonly config: {
    get<T = Record<string, unknown>>(): Promise<T>;
    onChange(handler: (config: Record<string, unknown>) => Promise<void>): void;
  };
}

export interface PluginEvents {
  "item.added": { itemId: string; kind: ItemKind };
  "item.removed": { itemId: string; kind: ItemKind };
  "item.updated": { itemId: string; kind: ItemKind };
  "progress.updated": { itemId: string; userId: string; positionSeconds: number; completed: boolean };
  "playback.started": { itemId: string; userId: string; sessionId: string };
  "playback.stopped": { itemId: string; userId: string; sessionId: string };
  "scan.completed": { libraryId: string; added: number; removed: number };
}

export interface PluginRequest {
  path: string;
  query: Record<string, string>;
  body: unknown;
  userId: string | null;
}

export interface PluginResponse {
  status: number;
  body: unknown;
}

export interface MetadataProvider {
  id: string;
  kinds: ItemKind[];
  search(query: { title: string; year?: number; kind: ItemKind }): Promise<MetadataMatch[]>;
  fetch(match: { providerId: string; kind: ItemKind }): Promise<MetadataResult>;
}

export interface MetadataMatch {
  providerId: string;
  title: string;
  year: number | null;
  confidence: number;
}

export interface MetadataResult {
  title: string;
  overview: string | null;
  year: number | null;
  contentRating: string | null;
  genres: string[];
  credits: { name: string; role: string; character?: string; order: number }[];
  artwork: { type: "poster" | "backdrop" | "logo" | "thumb"; url: string }[];
  providerIds: Record<string, string>;
}

export interface SubtitleProvider {
  id: string;
  search(query: { itemId: string; languages: string[] }): Promise<SubtitleMatch[]>;
  download(match: { providerId: string }): Promise<{ format: "srt" | "ass" | "vtt"; text: string }>;
}

export interface SubtitleMatch {
  providerId: string;
  language: string;
  forced: boolean;
  score: number;
}

export interface ArtworkProvider {
  id: string;
  kinds: ItemKind[];
  search(query: { itemId: string }): Promise<{ type: string; url: string; width: number; height: number }[]>;
}

export declare function definePlugin(setup: (host: PluginHost) => void | Promise<void>): unknown;
