import { startEventBroker } from "./api/events.ts";
import { createApiHandler } from "./api/handler.ts";
import { createHlsHandler } from "./api/hls.ts";
import { startApiServer } from "./api.ts";
import { createAuthHandler } from "./auth/http.ts";
import { createDatabase, probeDatabase } from "./db/client.ts";
import { migrateDatabase } from "./db/migrate.ts";
import { createJellyfinHandler } from "./jellyfin/http.ts";
import { jellyfinRoutes } from "./jellyfin/routes.ts";
import { createJellyfinSocket } from "./jellyfin/socket.ts";
import { createJobRegistry, jobRegistry } from "./jobs/registry.ts";
import { startJobWorker } from "./jobs/worker.ts";
import { registerLibraryJobs } from "./libraries/jobs.ts";
import { createLibraryRepair, type RepairOptions } from "./libraries/repair.ts";
import {
  type ChangeDebouncerOptions,
  createChangeDebouncer,
  createServarrWebhookHandler,
} from "./libraries/webhooks.ts";
import { artworkStoreConfig } from "./metadata/artwork-backends.ts";
import { createArtworkHandler } from "./metadata/artwork-http.ts";
import { registerMetadataJobs } from "./metadata/jobs.ts";
import { createPluginRouteHandler } from "./plugins/http.ts";
import {
  createPluginRuntime,
  type PluginRuntime,
  type PluginRuntimeOptions,
} from "./plugins/runtime.ts";
import { registerStoreJobs } from "./stored/jobs.ts";
import { createSubtitleHandler } from "./subtitles/http.ts";
import { registerSubtitleJobs } from "./subtitles/jobs.ts";
import {
  startTranscoder,
  type Transcoder,
  type TranscoderOptions,
} from "./transcoder/index.ts";
import { createWatcherHandler } from "./watcher/http.ts";
import {
  readWatcherConfig,
  startWatcher,
  type WatcherConfig,
  type WatcherOptions,
} from "./watcher/index.ts";

const roles = ["api", "worker", "transcoder", "watcher", "all"] as const;

/** A Thalia runtime role selected by --role. */
export type Role = (typeof roles)[number];

const minimumBunVersion = [1, 4, 0] as const;

function isRole(value: string): value is Role {
  return roles.some((role) => role === value);
}

function isSupportedBunVersion(version: string): boolean {
  const parsed = version.match(/^(\d+)\.(\d+)\.(\d+)/);

  if (parsed === null) {
    return false;
  }

  const current = parsed.slice(1).map(Number);

  for (const [index, minimum] of minimumBunVersion.entries()) {
    const part = current[index];

    if (part === undefined || part < minimum) {
      return false;
    }

    if (part > minimum) {
      return true;
    }
  }

  return true;
}

/** Reads the requested Thalia role from command-line arguments. */
export function parseRole(args: readonly string[]): Role {
  const optionIndex = args.indexOf("--role");
  const equalsOption = args.find((argument) => argument.startsWith("--role="));
  const value =
    optionIndex === -1
      ? equalsOption?.slice("--role=".length)
      : args[optionIndex + 1];

  if (optionIndex === -1 && equalsOption === undefined) {
    return "all";
  }

  if (value !== undefined && isRole(value)) {
    return value;
  }

  throw new Error(
    value === undefined
      ? `Missing value for --role. Expected one of: ${roles.join(", ")}.`
      : `Unknown role "${value}". Expected one of: ${roles.join(", ")}.`,
  );
}

/** Fails when the current Bun version is older than Thalia supports. */
export function requireSupportedBunVersion(version: string): void {
  if (!isSupportedBunVersion(version)) {
    throw new Error(
      `Thalia requires Bun 1.4.0 or later. Found ${version || "an unknown version"}.`,
    );
  }
}

function log(
  role: Role,
  message: string,
  data: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      ...data,
      timestamp: new Date().toISOString(),
      level: "info",
      role,
      message,
    }),
  );
}

function startRoles(
  role: Role,
  apiServer: ReturnType<typeof startApiServer> | undefined,
  workerStarted: boolean,
  transcoder: Transcoder | undefined,
  watcherStarted: boolean,
): void {
  const activeRoles = role === "all" ? roles.slice(0, -1) : [role];

  for (const activeRole of activeRoles) {
    log(activeRole, "role.started");

    if (activeRole === "api" && apiServer) {
      log(activeRole, "api.listening", { port: apiServer.port });
      continue;
    }

    if (activeRole === "worker" && workerStarted) continue;

    if (activeRole === "watcher" && watcherStarted) continue;

    if (activeRole === "transcoder" && transcoder) {
      log(activeRole, "transcoder.listening", {
        port: transcoder.port,
        address: transcoder.address,
        nodeId: transcoder.nodeId,
      });
      continue;
    }

    log(activeRole, "role.idle");
  }
}

type StartOptions = {
  databaseUrl?: string;
  port?: number;
  registry?: typeof jobRegistry;
  workerOptions?: Parameters<typeof startJobWorker>[2];
  brokerOptions?: Parameters<typeof startEventBroker>[1];
  changeOptions?: ChangeDebouncerOptions;
  repairOptions?: RepairOptions;
  transcoderOptions?: TranscoderOptions;
  pluginOptions?: Omit<PluginRuntimeOptions, "schedules">;
  /** The watcher's config; read from the environment when absent. */
  watcherConfig?: WatcherConfig;
  watcherOptions?: WatcherOptions;
};

/** Starts the selected roles and returns their shared shutdown operation. */
export async function startThalia(
  role: Role,
  {
    databaseUrl = process.env.DATABASE_URL,
    port,
    registry = jobRegistry,
    workerOptions,
    brokerOptions,
    changeOptions,
    repairOptions,
    transcoderOptions,
    pluginOptions,
    watcherConfig,
    watcherOptions,
  }: StartOptions = {},
) {
  const servesApi = role === "api" || role === "all";
  const runsJobs = role === "worker" || role === "all";
  const runsTranscoder = role === "transcoder" || role === "all";
  // A bad artwork store setting fails startup, not the first poster.
  if (servesApi || runsJobs) artworkStoreConfig();
  const database =
    servesApi || runsJobs || runsTranscoder
      ? createDatabase(databaseUrl)
      : undefined;
  let apiServer: ReturnType<typeof startApiServer> | undefined;
  let worker: Awaited<ReturnType<typeof startJobWorker>> | undefined;
  let eventBroker: Awaited<ReturnType<typeof startEventBroker>> | undefined;
  let changeDebouncer: ReturnType<typeof createChangeDebouncer> | undefined;
  let repair: ReturnType<typeof createLibraryRepair> | undefined;
  let transcoder: Transcoder | undefined;
  let plugins: PluginRuntime | undefined;
  let watcher: Awaited<ReturnType<typeof startWatcher>> | undefined;
  let stopping: Promise<void> | undefined;
  // Aborting stops a running store encode so the worker can drain.
  const storeShutdown = new AbortController();
  /** Stops accepting API work and store encodes, then stops the watcher, transcoder, debouncer, repair, worker, broker, API drain, plugins and database pool once. */
  function stop() {
    stopping ??= (async () => {
      storeShutdown.abort();
      const apiStopped = Promise.resolve(apiServer?.stop());
      apiStopped.catch(() => {});
      try {
        await watcher?.stop();
        await transcoder?.stop();
      } finally {
        try {
          await changeDebouncer?.close();
        } finally {
          try {
            await repair?.stop();
          } finally {
            try {
              await worker?.stop();
            } finally {
              try {
                await eventBroker?.stop();
              } finally {
                try {
                  await apiStopped;
                } finally {
                  try {
                    await plugins?.stop();
                  } finally {
                    await database?.close();
                  }
                }
              }
            }
          }
        }
      }
    })();
    return stopping;
  }
  try {
    if (servesApi && database && databaseUrl) {
      await migrateDatabase(database.db);
      log(role, "database.migrated");
      eventBroker = await startEventBroker(database.db, brokerOptions);
      changeDebouncer = createChangeDebouncer(database.db, {
        ...changeOptions,
        onError:
          changeOptions?.onError ??
          ((error: unknown) =>
            console.error(
              JSON.stringify({
                level: "error",
                role: "api",
                message: "changes.error",
                error: error instanceof Error ? error.message : String(error),
              }),
            )),
      });
      repair = createLibraryRepair(database.db, {
        ...repairOptions,
        onError:
          repairOptions?.onError ??
          ((error: unknown) =>
            console.error(
              JSON.stringify({
                level: "error",
                role: "api",
                message: "repair.error",
                error: error instanceof Error ? error.message : String(error),
              }),
            )),
      });
    }
    if ((servesApi || runsJobs) && database) {
      plugins = createPluginRuntime(database.db, {
        ...pluginOptions,
        schedules: runsJobs,
      });
      await plugins.start();
    }
    if (runsTranscoder && database) {
      transcoder = await startTranscoder(
        database.db,
        databaseUrl === undefined
          ? transcoderOptions
          : { ...transcoderOptions, ready: () => probeDatabase(databaseUrl) },
      );
    }
    if (
      servesApi &&
      database &&
      databaseUrl &&
      eventBroker &&
      changeDebouncer &&
      plugins
    ) {
      // Readiness opens its own short-lived connection: the pooled client's reconnect
      // path drops the response when the database host stops resolving.
      // Jellyfin images share the artwork handler, so they share its resize cache.
      const artwork = createArtworkHandler(database.db);
      apiServer = startApiServer(() => probeDatabase(databaseUrl), port, {
        auth: createAuthHandler(database.db),
        api: createApiHandler(database.db, eventBroker, transcoder, plugins),
        webhooks: createServarrWebhookHandler(database.db, changeDebouncer),
        artwork,
        subtitles: createSubtitleHandler(database.db),
        plugins: createPluginRouteHandler(database.db, plugins),
        jellyfin: createJellyfinHandler(
          database.db,
          jellyfinRoutes(artwork, createHlsHandler(database.db, transcoder), {
            plugins,
          }),
        ),
        socket: createJellyfinSocket(database.db, eventBroker),
        watcher: createWatcherHandler(database.db, changeDebouncer),
      });
    }
    if (runsJobs && database && plugins) {
      const runtime = plugins;
      const runtimeRegistry = createJobRegistry();
      for (const type of registry.types())
        runtimeRegistry.register(type, async (_payload, job) =>
          registry.run(job),
        );
      if (!runtimeRegistry.types().includes("scan"))
        registerLibraryJobs(database.db, runtimeRegistry);
      if (!runtimeRegistry.types().includes("provider-fetch"))
        registerMetadataJobs(database.db, runtimeRegistry, fetch, runtime);
      if (!runtimeRegistry.types().includes("subtitle-fetch"))
        registerSubtitleJobs(database.db, runtimeRegistry, fetch, runtime);
      if (!runtimeRegistry.types().includes("plugin"))
        runtimeRegistry.register("plugin", (payload) =>
          runtime.runJob(payload),
        );
      if (!runtimeRegistry.types().includes("store"))
        registerStoreJobs(database.db, runtimeRegistry, {
          signal: storeShutdown.signal,
        });
      worker = await startJobWorker(database.db, runtimeRegistry, {
        ...workerOptions,
        onError:
          workerOptions?.onError ??
          ((error: unknown) =>
            console.error(
              JSON.stringify({
                level: "error",
                role: "worker",
                message: "jobs.error",
                error: error instanceof Error ? error.message : String(error),
              }),
            )),
      });
    }
    if (role === "watcher") {
      watcher = await startWatcher(
        watcherConfig ?? readWatcherConfig(Bun.env),
        {
          ...watcherOptions,
          onError:
            watcherOptions?.onError ??
            ((error: unknown) =>
              console.error(
                JSON.stringify({
                  level: "error",
                  role: "watcher",
                  message: "watcher.error",
                  error: error instanceof Error ? error.message : String(error),
                }),
              )),
        },
      );
    }
    repair?.start();
    startRoles(
      role,
      apiServer,
      worker !== undefined,
      transcoder,
      watcher !== undefined,
    );
    return { apiServer, transcoder, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function run(): Promise<void> {
  requireSupportedBunVersion(Bun.version);
  const role = parseRole(Bun.argv);
  const server = await startThalia(role);
  try {
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
    });
    log(role, "server.stopping");
  } finally {
    await server.stop();
  }
}

if (import.meta.main) {
  void run().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "server.failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
