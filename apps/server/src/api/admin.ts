import { Schema } from "effect";
import { createLocalUser, isSetupComplete } from "../auth/accounts.ts";
import {
  getUserAccess,
  listGroups,
  listUsers,
  setGroupPermissions,
  setLibraryAccess,
  writeUserSettings,
} from "../auth/admin.ts";
import {
  createGroup,
  requirePermission,
  setPermissionOverride,
  setUserGroups,
} from "../auth/permissions.ts";
import { listSessions, revokeSession } from "../auth/sessions.ts";
import { readAuthSettings, writeAuthSettings } from "../auth/settings.ts";
import type { Database } from "../db/client.ts";
import {
  listProviderKeys,
  removeProviderKey,
  setProviderKey,
} from "../providers/keys.ts";
import { authenticated, authenticatedMutation, base } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import {
  AdminUser,
  Group,
  PermissionName,
  ServerSettings,
  Session,
  UserAccess,
  UserAccount,
} from "./schema.ts";

function instant(value: Date): string;
function instant(value: Date | null): string | null;
function instant(value: Date | null) {
  return value === null ? null : value.toISOString();
}

const toAdminUser = (user: Awaited<ReturnType<typeof listUsers>>[number]) => ({
  ...user,
  disabledAt: instant(user.disabledAt),
  createdAt: instant(user.createdAt),
});

const toSession = (
  session: Awaited<ReturnType<typeof listSessions>>[number],
) => ({
  ...session,
  createdAt: instant(session.createdAt),
  lastSeenAt: instant(session.lastSeenAt),
  expiresAt: instant(session.expiresAt),
  revokedAt: instant(session.revokedAt),
});

const toUserAccess = (access: Awaited<ReturnType<typeof getUserAccess>>) => ({
  user: toAdminUser(access.user),
  groupIds: access.groupIds,
  overrides: access.overrides,
  libraryAccess: access.libraryAccess,
  settings: {
    bitrateCapBps:
      access.settings.bitrateCapBps === null
        ? null
        : Number(access.settings.bitrateCapBps),
    contentRatingCeiling: access.settings.contentRatingCeiling,
  },
});

async function readServerSettings(db: Database, actorId: string) {
  const config = await readAuthSettings(db);
  const providerKeys = await listProviderKeys(db, actorId);
  return {
    trustedProxyAddresses: config.trustedProxyAddresses,
    artworkRequiresAuth: config.artworkRequiresAuth,
    oidcConfigured: config.oidc !== null,
    providerKeys,
  };
}

const idInput = Schema.standardSchemaV1(Schema.Struct({ id: Schema.UUID }));
const accessOutput = Schema.standardSchemaV1(UserAccess);
const settingsOutput = Schema.standardSchemaV1(ServerSettings);

/** The setup procedures mounted under `setup`. */
export const setupProcedures = {
  status: base
    .route({ method: "GET", path: "/setup/status" })
    .output(
      Schema.standardSchemaV1(Schema.Struct({ complete: Schema.Boolean })),
    )
    .handler(async ({ context }) =>
      runApi(
        fromHost(async () => ({
          complete: await isSetupComplete(context.db),
        })),
      ),
    ),
};

/** The user administration procedures mounted under `users`. */
export const userProcedures = {
  list: authenticated
    .route({ method: "GET", path: "/users" })
    .output(Schema.standardSchemaV1(Schema.Array(AdminUser)))
    .handler(async ({ context }) =>
      runApi(
        fromHost(async () =>
          (await listUsers(context.db, context.caller.user.id)).map(
            toAdminUser,
          ),
        ),
      ),
    ),
  get: authenticated
    .route({ method: "GET", path: "/users/{id}" })
    .input(idInput)
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () =>
          toUserAccess(
            await getUserAccess(context.db, context.caller.user.id, input.id),
          ),
        ),
      ),
    ),
  create: authenticatedMutation
    .route({ method: "POST", path: "/users" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          username: Schema.String,
          password: Schema.String,
          displayName: Schema.optional(Schema.String),
        }),
      ),
    )
    .output(Schema.standardSchemaV1(UserAccount))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(() =>
          createLocalUser(context.db, context.caller.user.id, input),
        ),
      ),
    ),
  sessions: authenticated
    .route({ method: "GET", path: "/users/{id}/sessions" })
    .input(idInput)
    .output(Schema.standardSchemaV1(Schema.Array(Session)))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () =>
          (
            await listSessions(context.db, context.caller.user.id, input.id)
          ).map(toSession),
        ),
      ),
    ),
  revokeSession: authenticatedMutation
    .route({ method: "POST", path: "/sessions/{id}/revoke" })
    .input(idInput)
    .output(Schema.standardSchemaV1(Schema.Struct({ ok: Schema.Boolean })))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await revokeSession(context.db, context.caller.user.id, input.id);
          return { ok: true };
        }),
      ),
    ),
  setGroups: authenticatedMutation
    .route({ method: "PUT", path: "/users/{id}/groups" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          groupIds: Schema.Array(Schema.UUID),
        }),
      ),
    )
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await setUserGroups(
            context.db,
            context.caller.user.id,
            input.id,
            input.groupIds,
          );
          return toUserAccess(
            await getUserAccess(context.db, context.caller.user.id, input.id),
          );
        }),
      ),
    ),
  setOverride: authenticatedMutation
    .route({ method: "PUT", path: "/users/{id}/overrides/{permission}" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          permission: PermissionName,
          allowed: Schema.NullOr(Schema.Boolean),
        }),
      ),
    )
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await setPermissionOverride(
            context.db,
            context.caller.user.id,
            input.id,
            input.permission,
            input.allowed,
          );
          return toUserAccess(
            await getUserAccess(context.db, context.caller.user.id, input.id),
          );
        }),
      ),
    ),
  setSettings: authenticatedMutation
    .route({ method: "PUT", path: "/users/{id}/settings" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          bitrateCapBps: Schema.NullOr(Schema.Int),
          contentRatingCeiling: Schema.NullOr(Schema.String),
        }),
      ),
    )
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await writeUserSettings(
            context.db,
            context.caller.user.id,
            input.id,
            {
              bitrateCapBps:
                input.bitrateCapBps === null
                  ? null
                  : BigInt(input.bitrateCapBps),
              contentRatingCeiling: input.contentRatingCeiling,
            },
          );
          return toUserAccess(
            await getUserAccess(context.db, context.caller.user.id, input.id),
          );
        }),
      ),
    ),
  setLibraryAccess: authenticatedMutation
    .route({ method: "PUT", path: "/users/{id}/libraries/{libraryId}" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          libraryId: Schema.UUID,
          allowed: Schema.NullOr(Schema.Boolean),
        }),
      ),
    )
    .output(accessOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await setLibraryAccess(context.db, context.caller.user.id, {
            libraryId: input.libraryId,
            userId: input.id,
            allowed: input.allowed,
          });
          return toUserAccess(
            await getUserAccess(context.db, context.caller.user.id, input.id),
          );
        }),
      ),
    ),
};

/** The group administration procedures mounted under `groups`. */
export const groupProcedures = {
  list: authenticated
    .route({ method: "GET", path: "/groups" })
    .output(Schema.standardSchemaV1(Schema.Array(Group)))
    .handler(async ({ context }) =>
      runApi(fromHost(() => listGroups(context.db, context.caller.user.id))),
    ),
  create: authenticatedMutation
    .route({ method: "POST", path: "/groups" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          name: Schema.String,
          permissions: Schema.Array(PermissionName),
        }),
      ),
    )
    .output(Schema.standardSchemaV1(Group))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(() => createGroup(context.db, context.caller.user.id, input)),
      ),
    ),
  setPermissions: authenticatedMutation
    .route({ method: "PUT", path: "/groups/{id}/permissions" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          id: Schema.UUID,
          permissions: Schema.Array(PermissionName),
        }),
      ),
    )
    .output(Schema.standardSchemaV1(Group))
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(() =>
          setGroupPermissions(
            context.db,
            context.caller.user.id,
            input.id,
            input.permissions,
          ),
        ),
      ),
    ),
};

/** The server settings procedures mounted under `settings`. */
export const settingsProcedures = {
  get: authenticated
    .route({ method: "GET", path: "/settings" })
    .output(settingsOutput)
    .handler(async ({ context }) =>
      runApi(
        fromHost(async () => {
          await requirePermission(
            context.db,
            context.caller.user.id,
            "manage-server",
          );
          return readServerSettings(context.db, context.caller.user.id);
        }),
      ),
    ),
  update: authenticatedMutation
    .route({ method: "PATCH", path: "/settings" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({
          trustedProxyAddresses: Schema.optional(Schema.Array(Schema.String)),
          artworkRequiresAuth: Schema.optional(Schema.Boolean),
        }),
      ),
    )
    .output(settingsOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await writeAuthSettings(context.db, context.caller.user.id, input);
          return readServerSettings(context.db, context.caller.user.id);
        }),
      ),
    ),
  setProviderKey: authenticatedMutation
    .route({ method: "PUT", path: "/settings/providers/{name}" })
    .input(
      Schema.standardSchemaV1(
        Schema.Struct({ name: Schema.String, value: Schema.String }),
      ),
    )
    .output(settingsOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await setProviderKey(
            context.db,
            context.caller.user.id,
            input.name,
            input.value,
          );
          return readServerSettings(context.db, context.caller.user.id);
        }),
      ),
    ),
  deleteProviderKey: authenticatedMutation
    .route({ method: "DELETE", path: "/settings/providers/{name}" })
    .input(Schema.standardSchemaV1(Schema.Struct({ name: Schema.String })))
    .output(settingsOutput)
    .handler(async ({ context, input }) =>
      runApi(
        fromHost(async () => {
          await removeProviderKey(
            context.db,
            context.caller.user.id,
            input.name,
          );
          return readServerSettings(context.db, context.caller.user.id);
        }),
      ),
    ),
};
