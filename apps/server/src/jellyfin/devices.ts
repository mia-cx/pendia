import { activeSessions, updateDevice } from "../auth/devices.ts";
import { AuthError } from "../auth/errors.ts";
import {
  readClientPreference,
  writeClientPreference,
} from "../auth/profile.ts";
import { readServerId } from "../server-id.ts";
import { json, noContent, type Route } from "./http.ts";
import { defaultValue, openapi } from "./openapi.ts";
import { parseGuid, toGuid } from "./request.ts";
import { readDto } from "./schema.ts";

const capabilities = {
  PlayableMediaTypes: ["Video"],
  SupportedCommands: [],
  SupportsMediaControl: false,
  SupportsPersistentIdentifier: true,
};

/** Device administration over live core sessions. */
export const deviceRoutes: Route[] = [
  {
    method: "GET",
    path: "/Devices",
    handle: async ({ db, caller, query }) => {
      const sessions = (await activeSessions(db, caller.user.id)).filter(
        (session) =>
          query.get("userId") === undefined ||
          session.userId === parseGuid(query.get("userId") ?? ""),
      );
      const devices = [
        ...new Map(
          sessions.map((session) => [session.deviceId, session]),
        ).values(),
      ];
      return json({
        Items: devices.map((session) => ({
          Id: session.deviceId,
          Name: session.deviceName,
          AppName: session.clientName,
          LastUserName: session.username,
          LastUserId: toGuid(session.userId),
          DateLastActivity: session.lastSeenAt.toISOString(),
          Capabilities: capabilities,
        })),
        TotalRecordCount: devices.length,
        StartIndex: 0,
      });
    },
  },
  {
    method: "GET",
    path: "/Devices/Info",
    handle: async ({ db, caller, query }) => {
      const session = (await activeSessions(db, caller.user.id)).find(
        (session) => session.deviceId === query.get("id"),
      );
      if (session === undefined) throw new AuthError("NOT_FOUND");
      return json({
        Id: session.deviceId,
        Name: session.deviceName,
        AppName: session.clientName,
        LastUserName: session.username,
        LastUserId: toGuid(session.userId),
        DateLastActivity: session.lastSeenAt.toISOString(),
        Capabilities: capabilities,
      });
    },
  },
  {
    method: "DELETE",
    path: "/Devices",
    handle: async ({ db, caller, query }) => {
      await updateDevice(db, caller.user.id, query.get("id") ?? "", {
        revoke: true,
      });
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/Devices/Options",
    handle: async ({ db, caller, query }) => {
      const session = (await activeSessions(db, caller.user.id)).find(
        (session) => session.deviceId === query.get("id"),
      );
      if (session === undefined) throw new AuthError("NOT_FOUND");
      return json({
        Id: 0,
        DeviceId: session.deviceId,
        CustomName: session.deviceName,
      });
    },
  },
  {
    method: "POST",
    path: "/Devices/Options",
    handle: async ({ db, caller, query, request }) => {
      const value = await readDto(request, "DeviceOptionsDto");
      if (typeof value.CustomName !== "string")
        throw new AuthError("INVALID_INPUT");
      await updateDevice(db, caller.user.id, query.get("id") ?? "", {
        name: value.CustomName,
      });
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/Sessions",
    handle: async ({ db, caller, query }) => {
      const serverId = await readServerId(db);
      const sessions = await activeSessions(db, caller.user.id);
      return json(
        await Promise.all(
          sessions
            .filter(
              (session) =>
                query.get("deviceId") === undefined ||
                session.deviceId === query.get("deviceId"),
            )
            .map(async (session) => {
              const stored = await readClientPreference(
                db,
                caller.user.id,
                session.userId,
                "session",
                session.id,
              );
              const declared =
                stored !== null &&
                typeof stored === "object" &&
                !Array.isArray(stored)
                  ? stored
                  : capabilities;
              return {
                ...(defaultValue(
                  openapi.components.schemas.SessionInfoDto ?? {},
                ) as object),
                Id: toGuid(session.id),
                UserId: toGuid(session.userId),
                UserName: session.username,
                DeviceId: session.deviceId,
                DeviceName: session.deviceName,
                Client: session.clientName,
                LastActivityDate: session.lastSeenAt.toISOString(),
                LastPlaybackCheckIn: session.lastSeenAt.toISOString(),
                ServerId: toGuid(serverId),
                IsActive: true,
                Capabilities: declared,
                PlayableMediaTypes: declared.PlayableMediaTypes ?? [],
                SupportedCommands: declared.SupportedCommands ?? [],
                NowPlayingItem: null,
                NowViewingItem: null,
              };
            }),
        ),
      );
    },
  },
  ...(["/Sessions/Capabilities", "/Sessions/Capabilities/Full"] as const).map(
    (path): Route => ({
      method: "POST",
      path,
      handle: async ({ db, caller, request, query }) => {
        if (caller.credential.kind !== "session")
          throw new AuthError("FORBIDDEN");
        const value = path.endsWith("/Full")
          ? await readDto(request, "ClientCapabilitiesDto")
          : {
              PlayableMediaTypes: query.list("playableMediaTypes"),
              SupportedCommands: query.list("supportedCommands"),
            };
        await writeClientPreference(
          db,
          caller.user.id,
          caller.user.id,
          "session",
          caller.credential.id,
          value,
        );
        return noContent();
      },
    }),
  ),
];
