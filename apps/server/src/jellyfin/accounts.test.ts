import { describe, expect, test } from "bun:test";
import { seedBrowse } from "../api/view-fixtures.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJellyfinHandler } from "./http.ts";
import { jellyfinRoutes } from "./routes.ts";
import { jellyfinLogin } from "./testing.ts";

describe.skipIf(!databaseUrl)("Jellyfin account and preference writes", () => {
  test("round-trips scoped preferences and integration keys, and preserves the last administrator", () =>
    withDatabase(async (db) => {
      const seed = await seedBrowse(db);
      const handle = createJellyfinHandler(
        db,
        jellyfinRoutes(
          async () => new Response(),
          async () => new Response(),
        ),
      );
      const send = (request: Request) => handle(request, "127.0.0.1");
      const header =
        'MediaBrowser Client="Web", Device="Browser", DeviceId="account-test"';
      const admin = await jellyfinLogin(send, header, "admin", "admin-pass");
      const viewer = await jellyfinLogin(send, header);
      const call = async (
        path: string,
        token = viewer,
        body?: object,
        method = body === undefined ? "GET" : "POST",
      ) => {
        const response = await send(
          new Request(`http://thalia.test${path}`, {
            method,
            headers: {
              "X-Emby-Token": token,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
        if (response === undefined) throw new Error(`Missing route ${path}`);
        return response;
      };
      const preferences = "/DisplayPreferences/home?client=web";
      expect(
        (
          await call(preferences, viewer, {
            ViewType: "List",
            CustomPrefs: { theme: "dark" },
          })
        ).status,
      ).toBe(204);
      expect(await (await call(preferences)).json()).toMatchObject({
        ViewType: "List",
        CustomPrefs: { theme: "dark" },
      });
      expect(
        await (await call("/DisplayPreferences/home?client=tv")).json(),
      ).toMatchObject({ ViewType: "Poster" });
      expect(
        (await call(`${preferences}&userId=${seed.admin.id}`)).status,
      ).toBe(403);
      expect(
        (await call(preferences, viewer, { ShowBackdrop: "wrong" })).status,
      ).toBe(400);
      expect(
        (
          await call("/Users/Configuration", viewer, {
            HidePlayedInLatest: false,
          })
        ).status,
      ).toBe(204);
      expect(await (await call("/Users/Me")).json()).toMatchObject({
        Configuration: { HidePlayedInLatest: false },
      });

      expect((await call("/Auth/Keys?app=Web", viewer, {})).status).toBe(403);
      expect((await call("/Auth/Keys?app=Web", admin, {})).status).toBe(204);
      const keys = (await (await call("/Auth/Keys", admin)).json()) as {
        Items: { AccessToken: string; AppName: string }[];
      };
      const key = keys.Items.find((key) => key.AppName === "Web");
      expect(key?.AccessToken.length).toBeGreaterThan(20);
      if (key === undefined) throw new Error("Missing integration key");
      expect((await call("/Users/Me", key.AccessToken)).status).toBe(200);
      expect((await call("/Auth/Keys", key.AccessToken)).status).toBe(403);
      expect(
        (
          await call(
            `/Auth/Keys/${key.AccessToken}`,
            admin,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(204);
      expect((await call("/Users/Me", key.AccessToken)).status).toBe(401);

      const policy = {
        AuthenticationProviderId:
          "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
        PasswordResetProviderId:
          "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider",
      };
      expect(
        (
          await call(`/Users/${seed.admin.id}/Policy`, admin, {
            ...policy,
            IsDisabled: true,
          })
        ).status,
      ).toBe(409);
      expect(
        (await call(`/Users/${seed.admin.id}`, admin, undefined, "DELETE"))
          .status,
      ).toBe(409);
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin, {
            ...policy,
            EnableMediaPlayback: false,
            EnableSubtitleManagement: true,
            RemoteClientBitrateLimit: 4_000_000,
          })
        ).status,
      ).toBe(204);
      expect(await (await call("/Users/Me")).json()).toMatchObject({
        Policy: {
          EnableMediaPlayback: false,
          EnableSubtitleManagement: true,
          RemoteClientBitrateLimit: 4_000_000,
        },
      });
      expect(
        (
          await call("/Users/Password", viewer, {
            CurrentPw: "wrong",
            NewPw: "new-pass",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await call("/Users/Password", viewer, {
            CurrentPw: "viewer-pass",
            NewPw: "new-pass",
          })
        ).status,
      ).toBe(204);
      expect(
        await jellyfinLogin(send, header, "viewer", "new-pass"),
      ).toBeString();
      expect(
        (
          await call(`/Users/${seed.viewer.id}/Policy`, admin, {
            ...policy,
            IsDisabled: true,
          })
        ).status,
      ).toBe(204);
      expect((await call("/Users/Me")).status).toBe(401);
    }));
});
