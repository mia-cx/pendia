import { startEventBroker } from "./api/events.ts";
import { createApiHandler } from "./api/handler.ts";
import { startApiServer } from "./api.ts";
import { createAuthHandler } from "./auth/http.ts";
import { createDatabase, probeDatabase } from "./db/client.ts";
import { migrateDatabase } from "./db/migrate.ts";
import { createJobRegistry, jobRegistry } from "./jobs/registry.ts";
import { startJobWorker } from "./jobs/worker.ts";
import { registerLibraryJobs } from "./libraries/jobs.ts";
import { createLibraryRepair, type RepairOptions } from "./libraries/repair.ts";
import {
  type ChangeDebouncerOptions,
  createChangeDebouncer,
  createServarrWebhookHandler,
} from "./libraries/webhooks.ts";

const roles = ["api", "worker", "transcoder", "watcher", "all"] as const;

/** A Pendia runtime role selected by --role. */
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

/** Reads the requested Pendia role from command-line arguments. */
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

/** Fails when the current Bun version is older than Pendia supports. */
export function requireSupportedBunVersion(version: string): void {
  if (!isSupportedBunVersion(version)) {
    throw new Error(
      `Pendia requires Bun 1.4.0 or later. Found ${version || "an unknown version"}.`,
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
  apiServer: Bun.Server<undefined> | undefined,
  workerStarted: boolean,
): void {
  const activeRoles = role === "all" ? roles.slice(0, -1) : [role];

  for (const activeRole of activeRoles) {
    log(activeRole, "role.started");

    if (activeRole === "api" && apiServer) {
      log(activeRole, "api.listening", { port: apiServer.port });
      continue;
    }

    if (activeRole === "worker" && workerStarted) continue;

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
};

/** Starts the selected roles and returns their shared shutdown operation. */
export async function startPendia(
  role: Role,
  {
    databaseUrl = process.env.DATABASE_URL,
    port,
    registry = jobRegistry,
    workerOptions,
    brokerOptions,
    changeOptions,
    repairOptions,
  }: StartOptions = {},
) {
  const servesApi = role === "api" || role === "all";
  const runsJobs = role === "worker" || role === "all";
  const database =
    servesApi || runsJobs ? createDatabase(databaseUrl) : undefined;
  let apiServer: Bun.Server<undefined> | undefined;
  let worker: Awaited<ReturnType<typeof startJobWorker>> | undefined;
  let eventBroker: Awaited<ReturnType<typeof startEventBroker>> | undefined;
  let changeDebouncer: ReturnType<typeof createChangeDebouncer> | undefined;
  let repair: ReturnType<typeof createLibraryRepair> | undefined;
  let stopping: Promise<void> | undefined;
  /** Stops the API server, change debouncer, repair controller, worker, event broker and database pool once, in that order. */
  function stop() {
    stopping ??= (async () => {
      try {
        await apiServer?.stop();
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
                await database?.close();
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
      // Readiness opens its own short-lived connection: the pooled client's reconnect
      // path drops the response when the database host stops resolving.
      apiServer = startApiServer(() => probeDatabase(databaseUrl), port, {
        auth: createAuthHandler(database.db),
        api: createApiHandler(database.db, eventBroker),
        webhooks: createServarrWebhookHandler(database.db, changeDebouncer),
      });
    }
    if (runsJobs && database) {
      const runtimeRegistry = createJobRegistry();
      for (const type of registry.types())
        runtimeRegistry.register(type, async (_payload, job) =>
          registry.run(job),
        );
      if (!registry.types().includes("scan"))
        registerLibraryJobs(database.db, runtimeRegistry);
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
    repair?.start();
    startRoles(role, apiServer, worker !== undefined);
    return { apiServer, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function run(): Promise<void> {
  requireSupportedBunVersion(Bun.version);
  const role = parseRole(Bun.argv);
  const server = await startPendia(role);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
