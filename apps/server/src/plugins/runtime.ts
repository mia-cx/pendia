import { join } from "node:path";
import type {
  Capability,
  MetadataProvider,
  PluginHost,
  PluginRequest,
  PluginResponse,
} from "@pendia/plugin-api";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { type JobPayload, jobs, pluginLockfile } from "../db/schema/index.ts";
import { jobChannel } from "../jobs/queue.ts";
import { assertPlainData } from "./boundary.ts";
import { type ConfigSchema, withDefaults } from "./config.ts";
import {
  createHost,
  createRegistrations,
  type Registrations,
  routeKey,
} from "./host.ts";
import {
  ensureInstalled,
  pluginDirectory,
  type SourceOptions,
} from "./install.ts";
import { readPluginPackage } from "./manifest.ts";
import {
  isFilesOff,
  type PluginSettings,
  type PluginState,
  pluginChannel,
  readPluginSettings,
  updatePluginSettings,
} from "./settings.ts";

/** A call into a plugin that threw or broke the boundary; the plugin is now failed and unloaded. */
export class PluginFailed extends Error {
  constructor(
    readonly plugin: string,
    cause: unknown,
  ) {
    super(
      `Plugin ${plugin} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PluginFailed";
  }
}

/** A plugin shelf resolved for one caller. */
export type ResolvedShelf = {
  plugin: string;
  id: string;
  title: string;
  itemIds: string[];
};

type Loaded = {
  name: string;
  integrity: string;
  /** Everything but config that, when it changes, means the host must be rebuilt. */
  stateKey: string;
  config: string;
  schema: ConfigSchema | null;
  registrations: Registrations;
  crons: Map<string, Bun.CronJob>;
  timer?: ReturnType<typeof setTimeout>;
};

type RuntimeOptions = {
  directory?: string;
  sourceOptions?: SourceOptions;
  /** Starts cron schedules; true in processes that run jobs. */
  schedules?: boolean;
  fetch?: typeof fetch;
};

const maxTimerDelayMs = 2_147_483_647;
// A fixed namespace makes one schedule tick map to one job id in every worker.
const scheduleNamespace = "6f0d8f2e-5f3a-4c1e-9b7e-2a4d6c8e0b13";

function logError(message: string, data: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      ...data,
      timestamp: new Date().toISOString(),
      level: "error",
      message,
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSetup(value: unknown): value is (host: PluginHost) => unknown {
  return typeof value === "function";
}

function stateKey(settings: PluginSettings, state: PluginState): string {
  const { config: _, ...rest } = state;
  return JSON.stringify({ ...rest, globalFilesOff: settings.filesOff });
}

function isResponse(value: unknown): value is PluginResponse {
  if (value === null || typeof value !== "object") return false;
  const status = "status" in value ? value.status : undefined;
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 599
  );
}

/** Enqueues one plugin job per schedule tick, once across every worker. */
async function enqueueTick(db: Database, pluginName: string, id: string) {
  const minute = new Date();
  minute.setUTCSeconds(0, 0);
  const jobId = Bun.randomUUIDv5(
    `${pluginName}\0${id}\0${minute.toISOString()}`,
    scheduleNamespace,
  );
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(jobs)
      .values({
        id: jobId,
        type: "plugin",
        payload: {
          type: "plugin",
          pluginName,
          jobId: `schedule:${id}`,
          data: {},
        },
        maxAttempts: 1,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (inserted.length > 0)
      await tx.execute(sql`select pg_notify(${jobChannel}, '')`);
  });
}

/** The per-process plugin runtime. */
export type PluginRuntime = ReturnType<typeof createPluginRuntime>;

/**
 * Creates the plugin runtime for one process. Plugins are imported on first
 * use, and every call into plugin code is guarded: a throw or a value that is
 * not plain data marks the plugin failed, logs it and unloads it.
 */
export function createPluginRuntime(
  db: Database,
  {
    directory = pluginDirectory(),
    sourceOptions,
    schedules = false,
    fetch: request = fetch,
  }: RuntimeOptions = {},
) {
  const loaded = new Map<string, Promise<Loaded | null>>();
  let subscription: { unlisten(): Promise<void> } | undefined;

  function unload(name: string) {
    const pending = loaded.get(name);
    loaded.delete(name);
    void pending?.then((plugin) => {
      if (plugin === null) return;
      for (const job of plugin.crons.values()) job.stop();
      clearTimeout(plugin.timer);
    });
  }

  async function fail(name: string, error: unknown) {
    const message = errorMessage(error);
    logError("plugin.failed", { plugin: name, error: message });
    unload(name);
    await updatePluginSettings(db, (current) => {
      const state = current.plugins[name];
      if (state === undefined || state.failure !== null) return current;
      const failure = { message, at: new Date().toISOString() };
      return {
        ...current,
        plugins: {
          ...current.plugins,
          [name]: { ...state, enabled: false, failure },
        },
      };
    });
  }

  /** Runs plugin code; a throw or a result that is not plain data fails the plugin. */
  async function guard<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      if (result !== undefined) assertPlainData(result, "result");
      return result;
    } catch (error) {
      await fail(name, error);
      throw new PluginFailed(name, error);
    }
  }

  function startCron(plugin: Loaded, id: string, cron: string) {
    if (!schedules) return { cancel() {} };
    plugin.crons.get(id)?.stop();
    const job = Bun.cron(cron, () =>
      enqueueTick(db, plugin.name, id).catch((error: unknown) =>
        logError("plugin.schedule.failed", {
          plugin: plugin.name,
          schedule: id,
          error: errorMessage(error),
        }),
      ),
    ).unref();
    plugin.crons.set(id, job);
    return {
      cancel() {
        job.stop();
        plugin.crons.delete(id);
      },
    };
  }

  async function open(name: string): Promise<Loaded | null> {
    const settings = await readPluginSettings(db);
    const state = settings.plugins[name];
    if (!state?.enabled) return null;
    const [locked] = await db
      .select()
      .from(pluginLockfile)
      .where(eq(pluginLockfile.name, name));
    if (locked === undefined) return null;
    let root: string;
    let manifest: ReturnType<typeof readPluginPackage>["manifest"];
    try {
      root = await ensureInstalled(directory, locked, sourceOptions);
      manifest = readPluginPackage(
        await Bun.file(join(root, "package.json")).json(),
      ).manifest;
    } catch (error) {
      // An install that fails here is this process's problem, such as an
      // unreachable source, not the plugin's: it stays enabled.
      logError("plugin.install.failed", {
        plugin: name,
        error: errorMessage(error),
      });
      return null;
    }
    const now = new Date();
    const filesOn =
      !isFilesOff(settings.filesOff, now) && !isFilesOff(state.filesOff, now);
    const capabilities = new Set<Capability>(
      state.capabilities.filter(
        (capability) => capability !== "files" || filesOn,
      ),
    );
    const plugin: Loaded = {
      name,
      integrity: locked.integrity,
      stateKey: stateKey(settings, state),
      config: JSON.stringify(state.config),
      schema: manifest.config,
      registrations: createRegistrations(),
      crons: new Map(),
    };
    const host = createHost({
      db,
      name,
      capabilities,
      network: manifest.network,
      registrations: plugin.registrations,
      config: async () =>
        withDefaults(
          manifest.config,
          (await readPluginSettings(db)).plugins[name]?.config ?? {},
        ),
      filesAllowed: async () => {
        const current = await readPluginSettings(db);
        const own = current.plugins[name];
        return (
          own?.enabled === true &&
          !isFilesOff(current.filesOff) &&
          !isFilesOff(own.filesOff)
        );
      },
      schedule: (id, cron) => startCron(plugin, id, cron),
      fetch: request,
    });
    const entry = join(root, manifest.entry);
    try {
      await guard(name, async () => {
        const module: { default?: unknown } = await import(entry);
        if (!isSetup(module.default))
          throw new TypeError(
            `${manifest.entry} must default-export definePlugin(...).`,
          );
        await module.default(host);
      });
    } catch {
      return null;
    }
    // A files switch that is off for a while comes back on by rebuilding the host.
    const until = [settings.filesOff, state.filesOff]
      .map((off) => (off?.until ? Date.parse(off.until) : Number.NaN))
      .filter((at) => at > now.getTime());
    if (state.capabilities.includes("files") && until.length > 0)
      plugin.timer = setTimeout(
        () => {
          unload(name);
          if (schedules) void loadAll("jobs");
        },
        Math.min(maxTimerDelayMs, Math.min(...until) - now.getTime()),
      );
    plugin.timer?.unref();
    return plugin;
  }

  /** Imports a plugin on first use; resolves null when it is disabled, failed or unavailable here. */
  function load(name: string): Promise<Loaded | null> {
    const existing = loaded.get(name);
    if (existing !== undefined) return existing;
    const pending = open(name).then(
      (plugin) => {
        if (plugin === null && loaded.get(name) === pending)
          loaded.delete(name);
        return plugin;
      },
      (error: unknown) => {
        if (loaded.get(name) === pending) loaded.delete(name);
        throw error;
      },
    );
    loaded.set(name, pending);
    return pending;
  }

  async function loadAll(capability: Capability): Promise<Loaded[]> {
    const settings = await readPluginSettings(db);
    const names = Object.entries(settings.plugins)
      .filter(
        ([, state]) => state.enabled && state.capabilities.includes(capability),
      )
      .map(([name]) => name);
    const plugins = await Promise.all(names.map(load));
    return plugins.filter((plugin) => plugin !== null);
  }

  async function sync() {
    const settings = await readPluginSettings(db);
    const locks = new Map(
      (await db.select().from(pluginLockfile)).map((row) => [
        row.name,
        row.integrity,
      ]),
    );
    for (const [name, pending] of [...loaded]) {
      const plugin = await pending.catch(() => null);
      if (plugin === null || loaded.get(name) !== pending) continue;
      const state = settings.plugins[name];
      if (
        state === undefined ||
        locks.get(name) !== plugin.integrity ||
        stateKey(settings, state) !== plugin.stateKey
      ) {
        unload(name);
        continue;
      }
      const config = JSON.stringify(state.config);
      if (config === plugin.config) continue;
      plugin.config = config;
      const current = withDefaults(plugin.schema, state.config);
      for (const handler of plugin.registrations.configHandlers)
        await guard(name, () => handler(current)).catch(() => {});
    }
    if (schedules) await loadAll("jobs");
  }

  return {
    /** Installs every locked plugin into this process's folder, logging what fails. */
    async installAll() {
      for (const locked of await db.select().from(pluginLockfile))
        await ensureInstalled(directory, locked, sourceOptions).catch(
          (error: unknown) =>
            logError("plugin.install.failed", {
              plugin: locked.name,
              error: errorMessage(error),
            }),
        );
    },

    /** Listens for plugin changes, then installs from the lockfile and starts schedules in the background. */
    async start() {
      const resync = () =>
        void sync().catch((error: unknown) =>
          logError("plugin.sync.failed", { error: errorMessage(error) }),
        );
      subscription = await db.$client.listen(pluginChannel, resync, resync);
      void this.installAll().then(() => {
        if (schedules) resync();
      });
    },

    /** Applies the current settings and lockfile to loaded plugins. */
    sync,

    /** Stops listening and unloads every plugin. */
    async stop() {
      await subscription?.unlisten();
      for (const name of [...loaded.keys()]) unload(name);
    },

    /** The metadata providers of every enabled plugin with the providers capability, guarded. */
    async metadataProviders(): Promise<MetadataProvider[]> {
      const plugins = await loadAll("providers");
      return plugins.flatMap((plugin) =>
        plugin.registrations.metadata.map((provider) => ({
          id: provider.id,
          kinds: [...provider.kinds],
          search: (query) => guard(plugin.name, () => provider.search(query)),
          fetch: (match) => guard(plugin.name, () => provider.fetch(match)),
        })),
      );
    },

    /** Resolves the plugin shelves for one placement; a failing shelf is left out. */
    async shelves(
      placement: "home" | "item",
      context: { userId: string; itemId?: string },
    ): Promise<ResolvedShelf[]> {
      const resolved: ResolvedShelf[] = [];
      for (const plugin of await loadAll("shelves"))
        for (const shelf of plugin.registrations.shelves) {
          if (shelf.placement !== placement) continue;
          try {
            const itemIds = await guard(plugin.name, async () => {
              const ids: unknown = await shelf.items({ ...context });
              if (
                !Array.isArray(ids) ||
                !ids.every((id) => typeof id === "string")
              )
                throw new TypeError(`Shelf ${shelf.id} must resolve item ids.`);
              return ids;
            });
            resolved.push({
              plugin: plugin.name,
              id: shelf.id,
              title: shelf.title,
              itemIds,
            });
          } catch (error) {
            if (!(error instanceof PluginFailed)) throw error;
          }
        }
      return resolved;
    },

    /** Runs a plugin route; resolves null when the plugin or route does not exist. */
    async route(
      name: string,
      method: string,
      path: string,
      pluginRequest: PluginRequest,
    ): Promise<PluginResponse | null> {
      const plugin = await load(name);
      const handler = plugin?.registrations.routes.get(routeKey(method, path));
      if (plugin === null || handler === undefined) return null;
      return guard(name, async () => {
        const response: unknown = await handler(pluginRequest);
        if (!isResponse(response))
          throw new TypeError("A route must resolve { status, body }.");
        return response;
      });
    },

    /** Runs a `plugin` job: an event delivery or a schedule tick. */
    async runJob(payload: Extract<JobPayload, { type: "plugin" }>) {
      const plugin = await load(payload.pluginName);
      if (plugin === null) return;
      const separator = payload.jobId.indexOf(":");
      const kind = payload.jobId.slice(0, separator);
      const key = payload.jobId.slice(separator + 1);
      const { events, schedules: registered } = plugin.registrations;
      if (kind === "event")
        for (const handler of events.get(key) ?? [])
          await guard(plugin.name, () => handler(payload.data));
      const scheduled = registered.get(key);
      if (kind === "schedule" && scheduled !== undefined)
        await guard(plugin.name, () => scheduled.handler());
    },

    /** Loads a plugin now and reports whether it is loaded. */
    async load(name: string) {
      return (await load(name)) !== null;
    },
  };
}
