import { describe, expect, test } from "bun:test";
import { setupAdmin } from "../auth/accounts.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { toGuid } from "./request.ts";
import { contractErrors } from "./testing.ts";

const infuse =
  'MediaBrowser Client="Infuse-Direct", Version="7.7", Device="Apple TV", DeviceId="infuse-1"';

describe.skipIf(!databaseUrl)("jellyfin auth", () => {
  test("logs in by name, reads the user and server, and logs out", () =>
    withDatabase(async (db, url) => {
      const thalia = await startThalia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${thalia.apiServer?.port}`;
        const admin = await setupAdmin(db, {
          username: "mia",
          password: "secret-pass",
        });
        const call = (path: string, init: RequestInit = {}) =>
          fetch(`${base}${path}`, init);
        const withToken = (token: string) => ({
          "X-Emby-Authorization": `${infuse}, Token="${token}"`,
        });

        const publicInfo = await call("/System/Info/Public");
        const publicBody = (await publicInfo.json()) as { Id: string };
        expect(contractErrors("PublicSystemInfo", publicBody)).toEqual([]);
        expect(publicBody).toMatchObject({
          ProductName: "Jellyfin Server",
          Version: "10.10.7",
          ServerName: "Thalia",
        });
        expect(publicBody.Id).toMatch(/^[0-9a-f]{32}$/);
        expect(await (await call("/Users/Public")).json()).toEqual([]);

        // Kodi sends a lowercase username key and web a lowercase path.
        const login = (password: string) =>
          call("/users/authenticatebyname", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-Emby-Authorization": infuse,
            },
            body: JSON.stringify({ username: "Mia", Pw: password }),
          });
        const wrong = await login("wrong-pass");
        expect(wrong.status).toBe(401);
        const right = await login("secret-pass");
        expect(right.status).toBe(200);
        const result = (await right.json()) as {
          AccessToken: string;
          ServerId: string;
          User: { Id: string; Name: string; Policy: object };
          SessionInfo: { Client: string; DeviceId: string; UserId: string };
        };
        expect(contractErrors("AuthenticationResult", result)).toEqual([]);
        expect(contractErrors("UserDto", result.User)).toEqual([]);
        expect(contractErrors("UserPolicy", result.User.Policy)).toEqual([]);
        expect(contractErrors("SessionInfoDto", result.SessionInfo)).toEqual(
          [],
        );
        expect(result.ServerId).toBe(publicBody.Id);
        expect(result.User).toMatchObject({
          Id: toGuid(admin.id),
          Name: "mia",
          Policy: { IsAdministrator: true, EnableMediaPlayback: true },
        });
        expect(result.SessionInfo).toMatchObject({
          Client: "Infuse-Direct",
          DeviceId: "infuse-1",
          UserId: toGuid(admin.id),
        });

        const token = result.AccessToken;
        expect((await call("/System/Info")).status).toBe(401);
        const info = await call("/System/Info", { headers: withToken(token) });
        const infoBody = await info.json();
        expect(contractErrors("SystemInfo", infoBody)).toEqual([]);
        expect(infoBody).toMatchObject({
          Id: publicBody.Id,
          WebSocketPortNumber: thalia.apiServer?.port,
        });

        const me = await call("/Users/Me", { headers: withToken(token) });
        const meBody = await me.json();
        expect(contractErrors("UserDto", meBody)).toEqual([]);
        expect(meBody).toEqual(result.User);

        const capabilities = await call("/Sessions/Capabilities/Full", {
          method: "POST",
          headers: { ...withToken(token), "content-type": "application/json" },
          body: JSON.stringify({ PlayableMediaTypes: ["Video"] }),
        });
        expect(capabilities.status).toBe(204);

        const legacy = await call(`/Users/${toGuid(admin.id)}/Items`, {
          headers: withToken(token),
        });
        expect(legacy.status).toBe(404);
        expect(legacy.headers.get("content-type")).toContain(
          "application/json",
        );

        const logout = await call("/Sessions/Logout", {
          method: "POST",
          headers: withToken(token),
        });
        expect(logout.status).toBe(204);
        const after = await call("/Users/Me", { headers: withToken(token) });
        expect(after.status).toBe(401);
      } finally {
        await thalia.stop();
      }
    }));
});
