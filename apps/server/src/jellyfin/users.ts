import { checkPermission, isBuiltInAdmin } from "../auth/permissions.ts";
import {
  type issueSession,
  login,
  revokeApiKey,
  revokeSession,
} from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { readServerId } from "../server-id.ts";
import { identify, json, noContent, type Route } from "./http.ts";
import { type ClientInfo, readBody, toGuid } from "./request.ts";

type User = { id: string; username: string; displayName: string };
type Issued = Awaited<ReturnType<typeof issueSession>>;

const authenticationProvider =
  "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider";
const passwordResetProvider =
  "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider";

/** Builds a Jellyfin UserDto. Name is the login name, since clients sign in with it. */
export async function userDto(db: Database, user: User, serverId: string) {
  const [isAdministrator, canPlay] = await Promise.all([
    isBuiltInAdmin(db, user.id),
    checkPermission(db, user.id, "play"),
  ]);
  return {
    Name: user.username,
    ServerId: toGuid(serverId),
    Id: toGuid(user.id),
    // `/Users/Public` lists nobody, so no client reads these to pick a login form.
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    Configuration: {
      PlayDefaultAudioTrack: true,
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: "Default",
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      IsAdministrator: isAdministrator,
      IsHidden: true,
      EnableCollectionManagement: false,
      EnableSubtitleManagement: false,
      EnableLyricManagement: false,
      IsDisabled: false,
      EnableUserPreferenceAccess: true,
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: canPlay,
      EnableAudioPlaybackTranscoding: canPlay,
      EnableVideoPlaybackTranscoding: canPlay,
      EnablePlaybackRemuxing: canPlay,
      ForceRemoteSourceTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDownloading: false,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnableAllDevices: true,
      EnableAllChannels: false,
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: authenticationProvider,
      PasswordResetProviderId: passwordResetProvider,
      SyncPlayAccess: "None",
    },
  };
}

function sessionInfo(issued: Issued, client: ClientInfo, serverId: string) {
  const { user, session } = issued;
  const lastSeen = session.lastSeenAt.toISOString();
  return {
    PlayState: {
      CanSeek: false,
      IsPaused: false,
      IsMuted: false,
      RepeatMode: "RepeatNone",
      PlaybackOrder: "Default",
    },
    Capabilities: {
      PlayableMediaTypes: [],
      SupportedCommands: [],
      SupportsMediaControl: false,
      SupportsPersistentIdentifier: true,
    },
    Id: toGuid(session.id),
    UserId: toGuid(user.id),
    UserName: user.username,
    Client: session.clientName,
    LastActivityDate: lastSeen,
    LastPlaybackCheckIn: lastSeen,
    DeviceName: session.deviceName,
    DeviceId: session.deviceId,
    ApplicationVersion: client.version ?? "",
    IsActive: true,
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
    HasCustomDeviceName: false,
    ServerId: toGuid(serverId),
    PlayableMediaTypes: [],
    SupportedCommands: [],
  };
}

/** Builds the AuthenticationResult a Jellyfin login answers with. */
export async function authenticationResult(
  db: Database,
  issued: Issued,
  client: ClientInfo,
) {
  const serverId = await readServerId(db);
  return {
    User: await userDto(db, issued.user, serverId),
    SessionInfo: sessionInfo(issued, client, serverId),
    AccessToken: issued.token,
    ServerId: toGuid(serverId),
  };
}

/** The device fields a new session takes from the MediaBrowser header. */
export function deviceOf(client: ClientInfo) {
  return {
    clientName: client.client ?? "",
    deviceId: client.deviceId ?? "",
    deviceName: client.device ?? "",
  };
}

/** Login, logout and the current user. */
export const userRoutes: Route[] = [
  {
    method: "POST",
    path: "/Users/AuthenticateByName",
    anonymous: true,
    handle: async (context) => {
      const body = await readBody(context.request);
      const { address } = await identify(context);
      const issued = await login(
        context.db,
        {
          username: body.string("Username"),
          password: body.string("Pw"),
          ...deviceOf(context.client),
        },
        address,
      );
      return json(
        await authenticationResult(context.db, issued, context.client),
      );
    },
  },
  {
    method: "POST",
    path: "/Sessions/Logout",
    handle: async ({ db, caller }) => {
      if (caller.credential.kind === "session")
        await revokeSession(db, caller.user.id, caller.credential.id);
      else await revokeApiKey(db, caller.user.id, caller.credential.id);
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/Users/Me",
    handle: async ({ db, caller }) =>
      json(await userDto(db, caller.user, await readServerId(db))),
  },
  // Login screens list public users first. Thalia shows none, so clients ask for a name.
  {
    method: "GET",
    path: "/Users/Public",
    anonymous: true,
    handle: () => json([]),
  },
  // Remote control is deferred, so a client's capabilities change nothing.
  {
    method: "POST",
    path: "/Sessions/Capabilities/Full",
    handle: () => noContent(),
  },
];
