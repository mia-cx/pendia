import { createLocalUser } from "../auth/accounts.ts";
import {
  getUserAccess,
  listGroups,
  listUsers,
  writeUserSettings,
} from "../auth/admin.ts";
import { AuthError } from "../auth/errors.ts";
import {
  createIntegrationKey,
  listIntegrationKeys,
  revokeIntegrationKey,
} from "../auth/integration-keys.ts";
import {
  isBuiltInAdmin,
  setPermissionOverride,
  setUserGroups,
} from "../auth/permissions.ts";
import {
  changePassword,
  readAccount,
  readClientPreference,
  removeAccount,
  renameAccount,
  requireAccountAccess,
  writeClientPreference,
} from "../auth/profile.ts";
import { readServerId } from "../server-id.ts";
import { json, noContent, type Route, type UserContext } from "./http.ts";
import { defaultValue, openapi } from "./openapi.ts";
import { requiredGuid, toGuid } from "./request.ts";
import { readDto } from "./schema.ts";
import { userDto } from "./users.ts";

async function targetUser(context: UserContext) {
  const text = context.params.userId ?? context.query.get("userId");
  const id = text === undefined ? context.caller.user.id : requiredGuid(text);
  await requireAccountAccess(context.db, context.caller.user.id, id);
  return id;
}

/** Real local account administration, user configuration, and administrator-managed API keys. */
export const accountRoutes: Route[] = [
  {
    method: "GET",
    path: "/Users",
    handle: async ({ db, caller, query }) => {
      const admin = await isBuiltInAdmin(db, caller.user.id);
      const users = admin
        ? await listUsers(db, caller.user.id)
        : [await readAccount(db, caller.user.id, caller.user.id)];
      const serverId = await readServerId(db);
      return json(
        await Promise.all(
          users
            .filter(
              (user) =>
                query.flag("isDisabled") === undefined ||
                (user.disabledAt !== null) === query.flag("isDisabled"),
            )
            .filter(() => query.flag("isHidden") !== false)
            .map((user) => userDto(db, user, serverId)),
        ),
      );
    },
  },
  {
    method: "GET",
    path: "/Users/{userId}",
    handle: async (context) =>
      json(
        await userDto(
          context.db,
          await readAccount(
            context.db,
            context.caller.user.id,
            await targetUser(context),
          ),
          await readServerId(context.db),
        ),
      ),
  },
  {
    method: "POST",
    path: "/Users/New",
    handle: async ({ db, caller, request }) => {
      const body = await readDto(request, "CreateUserByName");
      if (typeof body.Name !== "string") throw new AuthError("INVALID_INPUT");
      const user = await createLocalUser(
        db,
        caller.user.id,
        {
          username: body.Name,
          password: typeof body.Password === "string" ? body.Password : "",
        },
        { allowEmptyPassword: true },
      );
      return json(await userDto(db, user, await readServerId(db)));
    },
  },
  {
    method: "POST",
    path: "/Users",
    handle: async (context) => {
      const body = await readDto(context.request, "UserDto");
      if (typeof body.Name !== "string") throw new AuthError("INVALID_INPUT");
      await renameAccount(
        context.db,
        context.caller.user.id,
        await targetUser(context),
        body.Name,
      );
      return noContent();
    },
  },
  {
    method: "DELETE",
    path: "/Users/{userId}",
    handle: async (context) => {
      await removeAccount(
        context.db,
        context.caller.user.id,
        await targetUser(context),
      );
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Users/Password",
    handle: async (context) => {
      const body = await readDto(context.request, "UpdateUserPassword");
      await changePassword(
        context.db,
        context.caller.user.id,
        await targetUser(context),
        body.ResetPassword === true
          ? ""
          : typeof body.NewPw === "string"
            ? body.NewPw
            : "",
        typeof body.CurrentPw === "string" ? body.CurrentPw : undefined,
      );
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Users/Configuration",
    handle: async (context) => {
      const value = await readDto(context.request, "UserConfiguration");
      await writeClientPreference(
        context.db,
        context.caller.user.id,
        await targetUser(context),
        "jellyfin",
        "configuration",
        value,
      );
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Users/{userId}/Policy",
    handle: async (context) => {
      const userId = await targetUser(context);
      const policy = await readDto(context.request, "UserPolicy");
      const { db, caller } = context;
      if (typeof policy.IsAdministrator === "boolean") {
        const [access, groups] = await Promise.all([
          getUserAccess(db, caller.user.id, userId),
          listGroups(db, caller.user.id),
        ]);
        const admins = groups.find(
          (group) => group.builtIn && group.name === "admins",
        );
        if (admins === undefined)
          throw new Error("Seeded admins group missing.");
        await setUserGroups(
          db,
          caller.user.id,
          userId,
          policy.IsAdministrator
            ? [...new Set([...access.groupIds, admins.id])]
            : access.groupIds.filter((id) => id !== admins.id),
        );
      }
      if (typeof policy.EnableMediaPlayback === "boolean")
        await setPermissionOverride(
          db,
          caller.user.id,
          userId,
          "play",
          policy.EnableMediaPlayback,
        );
      if (typeof policy.EnableSubtitleManagement === "boolean")
        await setPermissionOverride(
          db,
          caller.user.id,
          userId,
          "manage-subtitles",
          policy.EnableSubtitleManagement,
        );
      if (typeof policy.RemoteClientBitrateLimit === "number") {
        const { settings } = await getUserAccess(db, caller.user.id, userId);
        await writeUserSettings(db, caller.user.id, userId, {
          ...settings,
          bitrateCapBps:
            policy.RemoteClientBitrateLimit > 0
              ? BigInt(policy.RemoteClientBitrateLimit)
              : null,
        });
      }
      if (typeof policy.IsDisabled === "boolean")
        await removeAccount(db, caller.user.id, userId, policy.IsDisabled);
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/Auth/Keys",
    handle: async ({ db, caller }) => {
      const keys = await listIntegrationKeys(db, caller.user.id);
      return json({
        Items: keys.map((key, index) => ({
          Id: index,
          AccessToken: key.token,
          AppName: key.name,
          UserId: toGuid(key.userId),
          UserName: key.username,
          IsActive: true,
          DateCreated: key.createdAt.toISOString(),
          DateLastActivity: (key.lastUsedAt ?? key.createdAt).toISOString(),
        })),
        TotalRecordCount: keys.length,
        StartIndex: 0,
      });
    },
  },
  {
    method: "POST",
    path: "/Auth/Keys",
    handle: async ({ db, caller, query }) => {
      await createIntegrationKey(db, caller.user.id, query.get("app") ?? "");
      return noContent();
    },
  },
  {
    method: "DELETE",
    path: "/Auth/Keys/{key}",
    handle: async ({ db, caller, params }) => {
      await revokeIntegrationKey(db, caller.user.id, params.key ?? "");
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/Auth/Providers",
    handle: () =>
      json([
        {
          Name: "Default",
          Id: "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
        },
      ]),
  },
  {
    method: "GET",
    path: "/Auth/PasswordResetProviders",
    handle: () =>
      json([
        {
          Name: "Default",
          Id: "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider",
        },
      ]),
  },
  {
    method: "POST",
    path: "/Users/ForgotPassword",
    anonymous: true,
    handle: () => json({ Action: "ContactAdmin" }),
  },
  {
    method: "POST",
    path: "/Users/ForgotPassword/Pin",
    anonymous: true,
    handle: () => json({ Success: false, UsersReset: [] }),
  },
];

/** Per-user, per-client display preferences round-trip the validated client payload. */
export const preferenceRoutes: Route[] = [
  {
    method: "GET",
    path: "/DisplayPreferences/{displayPreferencesId}",
    handle: async (context) => {
      const userId = await targetUser(context);
      const client = context.query.get("client") ?? "";
      const id = context.params.displayPreferencesId ?? "";
      const stored = await readClientPreference(
        context.db,
        context.caller.user.id,
        userId,
        client,
        id,
      );
      return json(
        stored ?? {
          ...(defaultValue(
            openapi.components.schemas.DisplayPreferencesDto ?? {},
          ) as object),
          Id: id,
          Client: client,
          CustomPrefs: {},
          ShowBackdrop: true,
          ShowSidebar: false,
          ViewType: "Poster",
          SortBy: "SortName",
          ScrollDirection: "Vertical",
        },
      );
    },
  },
  {
    method: "POST",
    path: "/DisplayPreferences/{displayPreferencesId}",
    handle: async (context) => {
      await writeClientPreference(
        context.db,
        context.caller.user.id,
        await targetUser(context),
        context.query.get("client") ?? "",
        context.params.displayPreferencesId ?? "",
        await readDto(context.request, "DisplayPreferencesDto"),
      );
      return noContent();
    },
  },
];
