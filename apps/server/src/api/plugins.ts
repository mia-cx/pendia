import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { pluginLockfile } from "../db/schema/index.ts";
import { configErrors, isJsonObject, withDefaults } from "../plugins/config.ts";
import { PluginError } from "../plugins/errors.ts";
import { capabilities } from "../plugins/manifest.ts";
import { addRegistry, removeRegistry } from "../plugins/registries.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import {
  type PluginSettings,
  readPluginSettings,
  updatePluginSettings,
  updatePluginState,
} from "../plugins/settings.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { ApiError, fromAuthError, runApi } from "./errors.ts";

const Capability = Schema.Literal(...capabilities);

const FilesOff = Schema.NullOr(
  Schema.Struct({ until: Schema.NullOr(Schema.String) }),
);

const ConfigType = Schema.Literal(
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
);

/** One top-level config property, as the settings form renders it. */
const ConfigField = Schema.Struct({
  key: Schema.String,
  type: Schema.NullOr(ConfigType),
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  required: Schema.Boolean,
  options: Schema.NullOr(Schema.Array(Schema.Unknown)),
});

const InstalledPlugin = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  source: Schema.String,
  capabilities: Schema.Array(Capability),
  network: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  failure: Schema.NullOr(
    Schema.Struct({ message: Schema.String, at: Schema.String }),
  ),
  filesOff: FilesOff,
  config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  configFields: Schema.Array(ConfigField),
});

const Plugins = Schema.Struct({
  filesOff: FilesOff,
  plugins: Schema.Array(InstalledPlugin),
});

const Preview = Schema.Struct({
  source: Schema.String,
  integrity: Schema.String,
  name: Schema.String,
  version: Schema.String,
  capabilities: Schema.Array(Capability),
  network: Schema.Array(Schema.String),
  installedVersion: Schema.NullOr(Schema.String),
});

const Registry = Schema.Struct({
  url: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.NullOr(Schema.String),
      versions: Schema.Array(
        Schema.Struct({ version: Schema.String, source: Schema.String }),
      ),
    }),
  ),
  error: Schema.NullOr(Schema.String),
});

const Source = Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(2048));
const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(214));
const Url = Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(2048));

const pluginsOutput = Schema.standardSchemaV1(Plugins);

type Context = {
  db: Database;
  caller: { user: { id: string } };
  plugins: PluginRuntime;
};

async function lockedPlugin(context: Context, name: string) {
  const [row] = await context.db
    .select()
    .from(pluginLockfile)
    .where(eq(pluginLockfile.name, name));
  return row;
}

/** Runs a plugin admin call for a caller holding manage-server, mapping plugin failures to API errors. */
function asAdmin<A>(context: Context, run: () => Promise<A>): Promise<A> {
  return runApi(
    Effect.tryPromise({
      try: async () => {
        await requirePermission(
          context.db,
          context.caller.user.id,
          "manage-server",
        );
        return run();
      },
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) => {
        if (error instanceof PluginError)
          return Effect.fail(
            new ApiError({ code: error.code, reason: error.message }),
          );
        if (error instanceof AuthError)
          return Effect.fail(fromAuthError(error));
        return Effect.die(error);
      }),
    ),
  );
}

async function listPlugins(context: Context, settings?: PluginSettings) {
  const current = settings ?? (await readPluginSettings(context.db));
  const locked = await context.db
    .select()
    .from(pluginLockfile)
    .orderBy(pluginLockfile.name);
  const plugins = await Promise.all(
    locked.flatMap((row) => {
      const state = current.plugins[row.name];
      if (state === undefined) return [];
      return context.plugins
        .manifest(row)
        .catch(() => null)
        .then((manifest) => ({
          name: row.name,
          version: row.version,
          source: row.source,
          capabilities: state.capabilities,
          network: manifest?.network ?? [],
          enabled: state.enabled,
          failure: state.failure,
          filesOff: state.filesOff,
          config: withDefaults(manifest?.config ?? null, state.config),
          configFields: Object.entries(manifest?.config?.properties ?? {}).map(
            ([key, field]) => ({
              key,
              type: field.type ?? null,
              title: field.title ?? null,
              description: field.description ?? null,
              required: manifest?.config?.required?.includes(key) ?? false,
              options: field.enum ?? null,
            }),
          ),
        }));
    }),
  );
  return { filesOff: current.filesOff, plugins };
}

function readFilesOff(input: { until: string | null } | null) {
  if (input?.until && Number.isNaN(Date.parse(input.until)))
    throw new PluginError("BAD_REQUEST", "until must be an ISO date.");
  return input === null ? null : { until: input.until };
}

/** The plugin admin procedures mounted under `plugins`, all behind manage-server. */
export const pluginProcedures = {
  list: authenticated
    .route({ method: "GET", path: "/plugins" })
    .output(pluginsOutput)
    .handler(async ({ context }) =>
      asAdmin(context, () => listPlugins(context)),
    ),
  preview: authenticatedMutation
    .route({ method: "POST", path: "/plugins/preview" })
    .input(Schema.standardSchemaV1(Schema.Struct({ source: Source })))
    .output(Schema.standardSchemaV1(Preview))
    .handler(async ({ context, input }) =>
      asAdmin(context, async () => {
        const fetched = await context.plugins.preview(input.source);
        const { name, version, manifest } = fetched.package;
        const installed = await lockedPlugin(context, name);
        return {
          source: fetched.source,
          integrity: fetched.integrity,
          name,
          version,
          capabilities: manifest.capabilities,
          network: manifest.network,
          installedVersion: installed?.version ?? null,
        };
      }),
    ),
  install: authenticatedMutation
    .route({ method: "POST", path: "/plugins/install" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({ source: Source, integrity: Schema.String }),
      ),
    )
    .output(pluginsOutput)
    .handler(async ({ context, input }) =>
      asAdmin(context, async () => {
        await context.plugins.install(input.source, input.integrity);
        return listPlugins(context);
      }),
    ),
  setEnabled: authenticatedMutation
    .route({ method: "POST", path: "/plugins/enabled" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({ name: Name, enabled: Schema.Boolean }),
      ),
    )
    .output(pluginsOutput)
    .handler(async ({ context, input }) =>
      asAdmin(context, async () =>
        listPlugins(
          context,
          await updatePluginState(context.db, input.name, (state) => ({
            ...state,
            enabled: input.enabled,
            // Re-enabling is how an admin restarts a failed plugin.
            failure: input.enabled ? null : state.failure,
          })),
        ),
      ),
    ),
  setFiles: authenticatedMutation
    .route({ method: "POST", path: "/plugins/files" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          name: Schema.optional(Name),
          off: FilesOff,
        }),
      ),
    )
    .output(pluginsOutput)
    .handler(async ({ context, input }) =>
      asAdmin(context, async () => {
        const off = readFilesOff(input.off);
        const { name } = input;
        const settings =
          name === undefined
            ? await updatePluginSettings(context.db, (current) => ({
                ...current,
                filesOff: off,
              }))
            : await updatePluginState(context.db, name, (state) => ({
                ...state,
                filesOff: off,
              }));
        return listPlugins(context, settings);
      }),
    ),
  setConfig: authenticatedMutation
    .route({ method: "POST", path: "/plugins/config" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          name: Name,
          config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
        }),
      ),
    )
    .output(pluginsOutput)
    .handler(async ({ context, input }) =>
      asAdmin(context, async () => {
        const row = await lockedPlugin(context, input.name);
        if (row === undefined)
          throw new PluginError("NOT_FOUND", `${input.name} is not installed.`);
        const { config } = input;
        if (!isJsonObject(config))
          throw new PluginError("BAD_REQUEST", "config must hold JSON values.");
        const schema = (await context.plugins.manifest(row)).config;
        const errors = schema === null ? [] : configErrors(schema, config);
        if (errors.length > 0)
          throw new PluginError("BAD_REQUEST", errors.join(" "));
        return listPlugins(
          context,
          await updatePluginState(context.db, input.name, (state) => ({
            ...state,
            config,
          })),
        );
      }),
    ),
};

/** The registry procedures mounted under `registries`, behind manage-server. */
export const registryProcedures = {
  list: authenticated
    .route({ method: "GET", path: "/registries" })
    .output(Schema.standardSchemaV1(Schema.Array(Registry)))
    .handler(async ({ context }) =>
      asAdmin(context, async () => {
        const { registries } = await readPluginSettings(context.db);
        return Promise.all(
          registries.map((url) =>
            context.plugins.registry(url).then(
              (entries) => ({ url, entries, error: null }),
              (error: unknown) => {
                if (!(error instanceof PluginError)) throw error;
                return { url, entries: [], error: error.message };
              },
            ),
          ),
        );
      }),
    ),
  add: authenticatedMutation
    .route({ method: "POST", path: "/registries" })
    .input(Schema.standardSchemaV1(Schema.Struct({ url: Url })))
    .output(Schema.standardSchemaV1(Schema.Array(Schema.String)))
    .handler(async ({ context, input }) =>
      asAdmin(
        context,
        async () => (await addRegistry(context.db, input.url)).registries,
      ),
    ),
  remove: authenticatedMutation
    .route({ method: "POST", path: "/registries/remove" })
    .input(Schema.standardSchemaV1(Schema.Struct({ url: Url })))
    .output(Schema.standardSchemaV1(Schema.Array(Schema.String)))
    .handler(async ({ context, input }) =>
      asAdmin(
        context,
        async () => (await removeRegistry(context.db, input.url)).registries,
      ),
    ),
};
