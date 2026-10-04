import { lstat, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  ArtworkProvider,
  Capability,
  Item,
  ItemKind,
  ItemQuery,
  MetadataProvider,
  PluginEvents,
  PluginHost,
  PluginRequest,
  PluginResponse,
  SubtitleProvider,
} from "@pendia/plugin-api";
import { and, asc, eq, gt, inArray, lt, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import {
  files,
  items,
  libraryRoots,
  progress,
  providerIds,
  versions,
} from "../db/schema/index.ts";
import { type LibraryRoot, rootsOf } from "../libraries/roots.ts";
import { assertPlainData } from "./boundary.ts";
import { anyHost } from "./manifest.ts";

/** A shelf a plugin registered. */
export type PluginShelf = Parameters<
  NonNullable<PluginHost["shelves"]>["register"]
>[0];

type Handler<T> = (payload: T) => Promise<void>;

/** Everything a plugin registered through its host, held by the runtime. */
export type Registrations = {
  metadata: MetadataProvider[];
  subtitles: SubtitleProvider[];
  artwork: ArtworkProvider[];
  shelves: PluginShelf[];
  /** Handlers by event name; payloads come back from the job queue as JSON. */
  events: Map<string, Handler<JsonObject>[]>;
  schedules: Map<string, { cron: string; handler: () => Promise<void> }>;
  routes: Map<string, (request: PluginRequest) => Promise<PluginResponse>>;
  configHandlers: Handler<Record<string, unknown>>[];
};

/** Creates an empty registration set for one plugin load. */
export function createRegistrations(): Registrations {
  return {
    metadata: [],
    subtitles: [],
    artwork: [],
    shelves: [],
    events: new Map(),
    schedules: new Map(),
    routes: new Map(),
    configHandlers: [],
  };
}

/** Every event a plugin may listen for. */
export const pluginEvents = [
  "item.added",
  "item.removed",
  "item.updated",
  "progress.updated",
  "playback.started",
  "playback.stopped",
  "scan.completed",
] as const satisfies readonly (keyof PluginEvents)[];

/** The key a route is registered and looked up under. */
export function routeKey(method: string, path: string): string {
  return `${method} /${path.replace(/^\/+/, "")}`;
}

/** What the runtime hands the host builder for one plugin. */
export type HostContext = {
  db: Database;
  name: string;
  /** Approved capabilities, minus files when it was switched off at load. */
  capabilities: ReadonlySet<Capability>;
  network: readonly string[];
  registrations: Registrations;
  /** The stored config with the schema's defaults filled in. */
  config: () => Promise<JsonObject>;
  /** Reports whether files is switched on right now, globally and for this plugin. */
  filesAllowed: () => Promise<boolean>;
  /** Starts a cron schedule in processes that run jobs; a no-op elsewhere. */
  schedule: (id: string, cron: string) => { cancel(): void };
  fetch: typeof fetch;
};

/** The largest read a plugin may ask for in one call. */
export const maxFileReadBytes = 16 * 1024 * 1024;
const maxQueryLimit = 500;
const defaultQueryLimit = 100;
const itemKinds: readonly ItemKind[] = ["movie", "show", "season", "episode"];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argument<T>(value: T, path: string): T {
  assertPlainData(value, path);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${path} must be a non-empty string.`);
  return value;
}

function requireUuid(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!uuidPattern.test(text)) throw new TypeError(`${path} must be a UUID.`);
  return text;
}

function requireFunction<T>(value: T, path: string): T {
  if (typeof value !== "function")
    throw new TypeError(`${path} must be a function.`);
  return value;
}

async function readItems(
  db: Database,
  where: SQL | undefined,
  limit: number,
): Promise<Item[]> {
  const rows = await db
    .select()
    .from(items)
    .where(where)
    .orderBy(asc(items.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [idRows, versionRows, fileRows] = await Promise.all([
    db.select().from(providerIds).where(inArray(providerIds.itemId, ids)),
    db
      .select()
      .from(versions)
      .where(inArray(versions.itemId, ids))
      .orderBy(asc(versions.id)),
    db
      .select()
      .from(files)
      .where(inArray(files.itemId, ids))
      .orderBy(asc(files.order)),
  ]);
  return rows.map((row) => ({
    id: row.id,
    libraryId: row.libraryId,
    kind: row.kind,
    parentId: row.parentId,
    title: row.title,
    year: row.year,
    providerIds: Object.fromEntries(
      idRows
        .filter((entry) => entry.itemId === row.id)
        .map((entry) => [entry.provider, entry.value]),
    ),
    addedAt: row.addedAt.toISOString(),
    versions: versionRows
      .filter((version) => version.itemId === row.id)
      .map((version) => ({
        id: version.id,
        label: version.label,
        format: version.format,
        bytes: Number(version.bytes),
        durationSeconds: version.durationSeconds,
        files: fileRows
          .filter((file) => file.versionId === version.id)
          .map((file) => ({
            path: file.path,
            bytes: Number(file.bytes),
            rootId: file.rootId,
          })),
      })),
  }));
}

function readQuery(raw: ItemQuery) {
  const query = argument(raw, "query");
  const limit = query.limit ?? defaultQueryLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxQueryLimit)
    throw new TypeError(`query.limit must be 1 to ${maxQueryLimit}.`);
  if (
    query.kind !== undefined &&
    !query.kind.every((kind) => itemKinds.includes(kind))
  )
    throw new TypeError("query.kind lists an unknown kind.");
  const addedBefore =
    query.addedBefore === undefined ? undefined : new Date(query.addedBefore);
  if (addedBefore !== undefined && Number.isNaN(addedBefore.getTime()))
    throw new TypeError("query.addedBefore must be an ISO date.");
  return {
    limit,
    where: and(
      query.kind === undefined ? undefined : inArray(items.kind, query.kind),
      query.libraryId === undefined
        ? undefined
        : eq(items.libraryId, requireUuid(query.libraryId, "query.libraryId")),
      query.parentId === undefined
        ? undefined
        : eq(items.parentId, requireUuid(query.parentId, "query.parentId")),
      addedBefore === undefined ? undefined : lt(items.addedAt, addedBefore),
      query.cursor === undefined
        ? undefined
        : gt(items.id, requireUuid(query.cursor, "query.cursor")),
    ),
  };
}

async function libraryPath(
  db: Database,
  rootOrLibraryId: string,
  path: string,
): Promise<string> {
  const id = requireUuid(rootOrLibraryId, "rootOrLibraryId");
  // A root id names that root alone; a library id names all of its roots.
  const [matched] = await db
    .select({ id: libraryRoots.id, path: libraryRoots.path })
    .from(libraryRoots)
    .where(eq(libraryRoots.id, id));
  const roots = matched === undefined ? await rootsOf(db, id) : [matched];
  const relative = requireString(path, "path");
  const outside = () => new Error(`${relative} is outside the library.`);
  // A path resolves in the first root holding it, else the first holding its folder.
  const holds = (at: string) => (root: LibraryRoot) =>
    lstat(resolve(root.path, at)).then(
      () => true,
      () => false,
    );
  const chosen =
    (await findRoot(roots, holds(relative))) ??
    (await findRoot(roots, holds(dirname(relative)))) ??
    roots[0];
  if (chosen === undefined)
    throw new Error(`Library ${rootOrLibraryId} does not exist.`);
  const root = await realpath(chosen.path);
  const target = resolve(root, relative);
  if (isAbsolute(relative) || !target.startsWith(`${root}${sep}`))
    throw outside();
  // Resolve links in the deepest part that exists, so a symlink inside the
  // library cannot carry a read, write or delete outside it.
  const missing: string[] = [];
  for (let existing = target; ; existing = dirname(existing)) {
    try {
      const real = join(await realpath(existing), ...missing);
      if (!real.startsWith(`${root}${sep}`)) throw outside();
      return real;
    } catch (error) {
      if (!isMissing(error)) throw error;
      // realpath also says ENOENT for a dangling link, which still points
      // somewhere; only a part that truly does not exist may be created.
      const dangling = await lstat(existing).then(
        () => true,
        () => false,
      );
      if (dangling) throw outside();
      missing.unshift(basename(existing));
    }
  }
}

async function findRoot(
  roots: readonly LibraryRoot[],
  matches: (root: LibraryRoot) => Promise<boolean>,
) {
  for (const root of roots) if (await matches(root)) return root;
  return undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function log(name: string, level: "info" | "warn" | "error") {
  return (message: string, data?: object) => {
    const line = JSON.stringify({
      ...data,
      timestamp: new Date().toISOString(),
      level,
      plugin: name,
      message: String(message),
    });
    if (level === "error") console.error(line);
    else console.log(line);
  };
}

/**
 * Builds the host object for one plugin. A capability the plugin lacks is an
 * absent member, never a member that throws. Arguments a plugin passes in are
 * checked as plain data.
 */
export function createHost(context: HostContext): PluginHost {
  const { db, name, registrations } = context;
  const has = (capability: Capability) => context.capabilities.has(capability);

  async function filePath(rootOrLibraryId: string, path: string) {
    if (!(await context.filesAllowed()))
      throw new Error(`File access is switched off for ${name}.`);
    return libraryPath(db, rootOrLibraryId, path);
  }

  return {
    api: "1.0.0",
    log: {
      info: log(name, "info"),
      warn: log(name, "warn"),
      error: log(name, "error"),
    },
    ...(has("items:read") && {
      items: {
        async query(query: ItemQuery) {
          const { where, limit } = readQuery(query);
          const found = await readItems(db, where, limit);
          return {
            items: found,
            cursor: found.length === limit ? (found.at(-1)?.id ?? null) : null,
          };
        },
        async get(id: string) {
          const [item] = await readItems(
            db,
            eq(items.id, requireUuid(id, "id")),
            1,
          );
          return item ?? null;
        },
        ...(has("items:write") && {
          async setTags(id: string, tags: string[]) {
            argument(tags, "tags");
            if (
              !Array.isArray(tags) ||
              !tags.every((tag) => typeof tag === "string")
            )
              throw new TypeError("tags must be a list of strings.");
            await db
              .update(items)
              .set({ tags: [...new Set(tags)], updatedAt: new Date() })
              .where(eq(items.id, requireUuid(id, "id")));
          },
        }),
      },
    }),
    ...(has("progress:read") && {
      progress: {
        async forItem(itemId: string) {
          const rows = await db
            .select()
            .from(progress)
            .where(eq(progress.itemId, requireUuid(itemId, "itemId")));
          return rows.map((row) => ({
            userId: row.userId,
            positionSeconds: row.positionSeconds,
            completed: row.completed,
            playedAt: row.playedAt?.toISOString() ?? null,
            playCount: row.playCount,
          }));
        },
      },
    }),
    ...(has("files") && {
      files: {
        async stat(rootOrLibraryId: string, path: string) {
          try {
            const found = await stat(await filePath(rootOrLibraryId, path));
            return found.isFile()
              ? { bytes: found.size, modifiedAt: found.mtime.toISOString() }
              : null;
          } catch (error) {
            if (isMissing(error)) return null;
            throw error;
          }
        },
        async read(
          rootOrLibraryId: string,
          path: string,
          range?: { offset: number; length: number },
        ) {
          const file = Bun.file(await filePath(rootOrLibraryId, path));
          const offset = range?.offset ?? 0;
          const length = range?.length ?? file.size - offset;
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0
          )
            throw new TypeError("range must hold non-negative integers.");
          if (length > maxFileReadBytes)
            throw new RangeError(
              `Reads are limited to ${maxFileReadBytes} bytes; pass a range.`,
            );
          return file.slice(offset, offset + length).bytes();
        },
        async write(rootOrLibraryId: string, path: string, bytes: Uint8Array) {
          if (!(bytes instanceof Uint8Array))
            throw new TypeError("bytes must be a Uint8Array.");
          await Bun.write(await filePath(rootOrLibraryId, path), bytes);
        },
        async delete(rootOrLibraryId: string, path: string) {
          await rm(await filePath(rootOrLibraryId, path));
        },
      },
    }),
    ...(has("providers") && {
      providers: {
        metadata(provider: MetadataProvider) {
          requireString(provider.id, "provider.id");
          requireFunction(provider.search, "provider.search");
          requireFunction(provider.fetch, "provider.fetch");
          argument(provider.kinds, "provider.kinds");
          registrations.metadata.push(provider);
        },
        subtitles(provider: SubtitleProvider) {
          requireString(provider.id, "provider.id");
          requireFunction(provider.search, "provider.search");
          requireFunction(provider.download, "provider.download");
          registrations.subtitles.push(provider);
        },
        artwork(provider: ArtworkProvider) {
          requireString(provider.id, "provider.id");
          requireFunction(provider.search, "provider.search");
          argument(provider.kinds, "provider.kinds");
          registrations.artwork.push(provider);
        },
      },
    }),
    ...(has("shelves") && {
      shelves: {
        register(shelf: PluginShelf) {
          requireString(shelf.id, "shelf.id");
          requireString(shelf.title, "shelf.title");
          if (shelf.placement !== "home" && shelf.placement !== "item")
            throw new TypeError('shelf.placement must be "home" or "item".');
          requireFunction(shelf.items, "shelf.items");
          registrations.shelves.push(shelf);
        },
      },
    }),
    ...(has("events") && {
      events: {
        on<E extends keyof PluginEvents>(
          event: E,
          handler: Handler<PluginEvents[E]>,
        ) {
          if (!pluginEvents.includes(event))
            throw new TypeError(`${String(event)} is not a plugin event.`);
          requireFunction(handler, "handler");
          const handlers = registrations.events.get(event) ?? [];
          // The emitter enqueued exactly this event's payload.
          handlers.push((payload) => handler(payload as PluginEvents[E]));
          registrations.events.set(event, handlers);
        },
      },
    }),
    ...(has("jobs") && {
      jobs: {
        schedule(id: string, cron: string, handler: () => Promise<void>) {
          requireString(id, "id");
          requireFunction(handler, "handler");
          Bun.cron.parse(requireString(cron, "cron"));
          const entry = { cron, handler };
          registrations.schedules.set(id, entry);
          const started = context.schedule(id, cron);
          return {
            cancel() {
              started.cancel();
              // A later schedule with the same id replaced this one; leave it.
              if (registrations.schedules.get(id) === entry)
                registrations.schedules.delete(id);
            },
          };
        },
      },
    }),
    ...(has("http") && {
      http: {
        route(
          method: "GET" | "POST",
          path: string,
          handler: (request: PluginRequest) => Promise<PluginResponse>,
        ) {
          if (method !== "GET" && method !== "POST")
            throw new TypeError('method must be "GET" or "POST".');
          requireFunction(handler, "handler");
          registrations.routes.set(
            routeKey(method, requireString(path, "path")),
            handler,
          );
        },
      },
    }),
    ...(has("network") && {
      async fetch(url: string, init?: RequestInit) {
        const target = new URL(requireString(url, "url"));
        if (target.protocol !== "http:" && target.protocol !== "https:")
          throw new Error(`${name} may only fetch http and https URLs.`);
        if (
          !context.network.includes(anyHost) &&
          !context.network.includes(target.hostname)
        )
          throw new Error(
            `${name} may not reach ${target.hostname}; its manifest lists ${context.network.join(", ") || "no hosts"}.`,
          );
        // Redirects come back to the plugin, so every hop passes this check.
        return context.fetch(target, { ...init, redirect: "manual" });
      },
    }),
    config: {
      async get<T = Record<string, unknown>>() {
        return (await context.config()) as T;
      },
      onChange(handler: Handler<Record<string, unknown>>) {
        registrations.configHandlers.push(requireFunction(handler, "handler"));
      },
    },
  };
}
