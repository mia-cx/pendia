import { listItemViews, listVersionViews } from "../api/views.ts";
import { activeSessions, updateDevice } from "../auth/devices.ts";
import { AuthError } from "../auth/errors.ts";
import {
  readClientPreference,
  writeClientPreference,
} from "../auth/profile.ts";
import { listPlaybackActivity } from "../playback/activity.ts";
import { readServerId } from "../server-id.ts";
import { json, noContent, type Route } from "./http.ts";
import { baseItemDto } from "./items.ts";
import { defaultValue, openapi } from "./openapi.ts";
import { parseGuid, requiredGuid, ticksPerSecond, toGuid } from "./request.ts";
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
      const plays = await listPlaybackActivity(
        db,
        caller.user.id,
        sessions.map((session) => session.id),
      );
      return json(
        await Promise.all(
          sessions
            .filter(
              (session) =>
                (query.get("deviceId") === undefined ||
                  session.deviceId === query.get("deviceId")) &&
                (query.count("activeWithinSeconds") === undefined ||
                  session.lastSeenAt.getTime() >
                    Date.now() -
                      (query.count("activeWithinSeconds") ?? 0) * 1000) &&
                (query.get("controllableByUserId") === undefined ||
                  session.userId ===
                    requiredGuid(query.get("controllableByUserId"))),
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
              const play = plays.find(
                (play) => play.credentialId === session.id,
              );
              const nowPlaying =
                play === undefined
                  ? undefined
                  : (
                      await listItemViews(db, session.userId, {
                        ids: [play.itemId],
                      })
                    ).items[0];
              const state =
                play === undefined
                  ? null
                  : await readClientPreference(
                      db,
                      caller.user.id,
                      session.userId,
                      "playback-state",
                      play.id,
                    );
              const stateFields =
                state !== null &&
                typeof state === "object" &&
                !Array.isArray(state)
                  ? state
                  : {};
              const version =
                play === undefined
                  ? undefined
                  : (
                      await listVersionViews(db, session.userId, play.itemId)
                    ).find((version) => version.id === play.versionId);
              const audioIndex = play?.decision?.selection.audio;
              const subtitleIndex = play?.decision?.selection.subtitle;
              const selectedAudio =
                audioIndex == null
                  ? null
                  : (version?.streams.filter(
                      (stream) => stream.kind === "audio",
                    )[audioIndex]?.index ?? null);
              const selectedSubtitle =
                subtitleIndex === null
                  ? -1
                  : subtitleIndex === undefined
                    ? null
                    : (version?.streams.filter(
                        (stream) => stream.kind === "subtitle",
                      )[subtitleIndex]?.index ?? null);
              const viewing = await readClientPreference(
                db,
                caller.user.id,
                session.userId,
                "session-view",
                session.id,
              );
              const viewedId =
                viewing !== null &&
                typeof viewing === "object" &&
                !Array.isArray(viewing) &&
                typeof viewing.itemId === "string"
                  ? viewing.itemId
                  : undefined;
              const viewed =
                viewedId === undefined
                  ? undefined
                  : (
                      await listItemViews(db, session.userId, {
                        ids: [viewedId],
                      })
                    ).items[0];
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
                LastPlaybackCheckIn: (
                  play?.lastSeenAt ?? session.lastSeenAt
                ).toISOString(),
                ServerId: toGuid(serverId),
                IsActive: true,
                Capabilities: declared,
                PlayableMediaTypes: declared.PlayableMediaTypes ?? [],
                SupportedCommands: declared.SupportedCommands ?? [],
                NowPlayingItem:
                  nowPlaying === undefined
                    ? null
                    : baseItemDto(nowPlaying, serverId),
                NowViewingItem:
                  viewed === undefined ? null : baseItemDto(viewed, serverId),
                PlayState: {
                  PositionTicks: Math.round(
                    (typeof stateFields.positionSeconds === "number"
                      ? stateFields.positionSeconds
                      : (play?.positionSeconds ?? 0)) * ticksPerSecond,
                  ),
                  IsPaused: stateFields.paused === true,
                  IsMuted: stateFields.muted === true,
                  CanSeek: stateFields.canSeek === true,
                  VolumeLevel:
                    typeof stateFields.volume === "number"
                      ? stateFields.volume
                      : null,
                  AudioStreamIndex:
                    typeof stateFields.audioStreamIndex === "number"
                      ? stateFields.audioStreamIndex
                      : selectedAudio,
                  SubtitleStreamIndex:
                    typeof stateFields.subtitleStreamIndex === "number"
                      ? stateFields.subtitleStreamIndex
                      : selectedSubtitle,
                  MediaSourceId:
                    play === undefined ? null : toGuid(play.versionId),
                  PlayMethod:
                    play === undefined
                      ? null
                      : play.method === "direct-play"
                        ? "DirectPlay"
                        : play.method === "remux"
                          ? "DirectStream"
                          : "Transcode",
                  RepeatMode: "RepeatNone",
                  PlaybackOrder: "Default",
                },
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
              SupportsMediaControl: query.flag("supportsMediaControl") ?? false,
              SupportsPersistentIdentifier:
                query.flag("supportsPersistentIdentifier") ?? false,
            };
        const id =
          query.get("id") === undefined
            ? caller.credential.id
            : requiredGuid(query.get("id"));
        const session = (await activeSessions(db, caller.user.id)).find(
          (session) => session.id === id,
        );
        if (session === undefined) throw new AuthError("NOT_FOUND");
        await writeClientPreference(
          db,
          caller.user.id,
          session.userId,
          "session",
          id,
          value,
        );
        return noContent();
      },
    }),
  ),
  ...["/Sessions/Viewing", "/Sessions/{sessionId}/Viewing"].map(
    (path): Route => ({
      method: "POST",
      path,
      handle: async ({ db, caller, params, query }) => {
        if (caller.credential.kind !== "session")
          throw new AuthError("FORBIDDEN");
        const id = params.sessionId ?? query.get("sessionId");
        const sessionId =
          id === undefined ? caller.credential.id : requiredGuid(id);
        const session = (await activeSessions(db, caller.user.id)).find(
          (session) => session.id === sessionId,
        );
        if (session === undefined) throw new AuthError("NOT_FOUND");
        await writeClientPreference(
          db,
          caller.user.id,
          session.userId,
          "session-view",
          sessionId,
          { itemId: requiredGuid(query.get("itemId")) },
        );
        return noContent();
      },
    }),
  ),
];
