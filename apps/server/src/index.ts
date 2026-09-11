import { startApiServer } from "./api.ts";
import { createDatabase } from "./db/client.ts";
import { migrateDatabase } from "./db/migrate.ts";

const roles = ["api", "worker", "transcoder", "watcher", "all"] as const;

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

function startRoles(role: Role): Bun.Server<undefined> | undefined {
  const activeRoles = role === "all" ? roles.slice(0, -1) : [role];
  let apiServer: Bun.Server<undefined> | undefined;

  for (const activeRole of activeRoles) {
    log(activeRole, "role.started");

    if (activeRole === "api") {
      apiServer = startApiServer();
      log(activeRole, "api.listening", { port: apiServer.port });
      continue;
    }

    log(activeRole, "role.idle");
  }

  return apiServer;
}

async function run(): Promise<void> {
  requireSupportedBunVersion(Bun.version);
  const role = parseRole(Bun.argv);

  const database =
    role === "api" || role === "all" ? createDatabase() : undefined;
  let apiServer: Bun.Server<undefined> | undefined;
  try {
    if (database) {
      await migrateDatabase(database.db);
      log(role, "database.migrated");
    }
    apiServer = startRoles(role);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
    });
    log(role, "server.stopping");
  } finally {
    try {
      await apiServer?.stop();
    } finally {
      await database?.close();
    }
  }
}

if (import.meta.main) {
  void run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
