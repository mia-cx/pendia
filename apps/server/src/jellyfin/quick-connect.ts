import { AuthError } from "../auth/errors.ts";
import {
  authenticateWithQuickConnect,
  authorizeQuickConnect,
  initiateQuickConnect,
  quickConnectState,
} from "../auth/quick-connect.ts";
import { identify, json, type Route } from "./http.ts";
import { parseGuid, readBody } from "./request.ts";
import { authenticationResult, deviceOf } from "./users.ts";

function quickConnectResult(
  request: Awaited<ReturnType<typeof quickConnectState>>,
  secret: string,
) {
  return {
    Authenticated: request.authorized,
    Secret: secret,
    Code: request.code,
    DeviceId: request.deviceId,
    DeviceName: request.deviceName,
    AppName: request.clientName,
    AppVersion: request.clientVersion,
    DateAdded: request.createdAt.toISOString(),
  };
}

/** Quick Connect: a device shows a code, a signed-in client approves it, the device logs in. */
export const quickConnectRoutes: Route[] = [
  {
    method: "GET",
    path: "/QuickConnect/Enabled",
    anonymous: true,
    handle: () => json(true),
  },
  {
    method: "POST",
    path: "/QuickConnect/Initiate",
    anonymous: true,
    handle: async (context) => {
      const { db, client } = context;
      const { address } = await identify(context);
      const { secret, request } = await initiateQuickConnect(
        db,
        { ...deviceOf(client), clientVersion: client.version ?? "" },
        address,
      );
      return json(quickConnectResult(request, secret));
    },
  },
  {
    method: "GET",
    path: "/QuickConnect/Connect",
    anonymous: true,
    handle: async ({ db, query }) => {
      const secret = query.get("secret") ?? "";
      return json(
        quickConnectResult(await quickConnectState(db, secret), secret),
      );
    },
  },
  {
    method: "POST",
    path: "/QuickConnect/Authorize",
    handle: async ({ db, query, caller }) => {
      // Jellyfin lets the caller name the user. Pendia approves for the caller only.
      const userId = query.get("userId");
      if (userId !== undefined && parseGuid(userId) !== caller.user.id)
        throw new AuthError("FORBIDDEN");
      await authorizeQuickConnect(db, caller.user.id, query.get("code") ?? "");
      return json(true);
    },
  },
  {
    method: "POST",
    path: "/Users/AuthenticateWithQuickConnect",
    anonymous: true,
    handle: async ({ db, request, client }) => {
      const body = await readBody(request);
      const issued = await authenticateWithQuickConnect(
        db,
        body.string("Secret"),
      );
      return json(await authenticationResult(db, issued, client));
    },
  },
];
