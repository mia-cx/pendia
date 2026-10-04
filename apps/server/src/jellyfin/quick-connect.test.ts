import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createHlsHandler } from "../api/hls.ts";
import { setupAdmin } from "../auth/accounts.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { quickConnectRequests } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { createJellyfinHandler } from "./http.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { contractErrors } from "./testing.ts";

// Every open-source client polls Quick Connect at this interval.
const pollMs = 5_000;
const androidTv =
  'MediaBrowser Client="Android TV", Version="0.18.0", DeviceId="tv-1", Device="Shield"';
const swiftfin =
  "MediaBrowser DeviceId=phone-1, Device=iPhone, Client=Swiftfin, Version=1.3";

type QuickConnectResult = {
  Authenticated: boolean;
  Secret: string;
  Code: string;
};

// Migrates, creates an admin, and signs Swiftfin in as the approving client.
async function setup(db: Database) {
  await migrateDatabase(db);
  const admin = await setupAdmin(db, {
    username: "mia",
    password: "secret-pass",
  });
  const handle = createJellyfinHandler(
    db,
    jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
  );
  const call = async (
    method: string,
    path: string,
    header: string,
    body?: object,
  ) => {
    const response = await handle(
      new Request(`http://pendia.test${path}`, {
        method,
        headers: { "content-type": "application/json", Authorization: header },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      "127.0.0.1",
    );
    if (response === undefined) throw new Error(`${path} unrouted`);
    return response;
  };
  const signedIn = (await (
    await call("POST", "/Users/AuthenticateByName", swiftfin, {
      Username: "mia",
      Pw: "secret-pass",
    })
  ).json()) as { AccessToken: string };
  return {
    admin,
    call,
    approver: `${swiftfin}, Token=${signedIn.AccessToken}`,
  };
}

describe.skipIf(!databaseUrl)("jellyfin quick connect", () => {
  test(
    "a polling device logs in once after a signed-in client approves its code",
    () =>
      withDatabase(async (db) => {
        const { admin, call, approver } = await setup(db);

        expect(
          await (await call("GET", "/QuickConnect/Enabled", androidTv)).json(),
        ).toBe(true);
        const initiated = await call(
          "POST",
          "/QuickConnect/Initiate",
          androidTv,
        );
        const started = (await initiated.json()) as QuickConnectResult;
        expect(contractErrors("QuickConnectResult", started)).toEqual([]);
        expect(started).toMatchObject({
          Authenticated: false,
          DeviceId: "tv-1",
          DeviceName: "Shield",
          AppName: "Android TV",
          AppVersion: "0.18.0",
        });
        expect(started.Code).toMatch(/^\d{6}$/);

        // The device polls every 5 s; the phone approves between two polls.
        const polls: QuickConnectResult[] = [];
        for (;;) {
          const poll = await call(
            "GET",
            `/QuickConnect/Connect?Secret=${started.Secret}`,
            androidTv,
          );
          polls.push((await poll.json()) as QuickConnectResult);
          if (polls.at(-1)?.Authenticated) break;
          if (polls.length === 1) {
            const approved = await call(
              "POST",
              `/QuickConnect/Authorize?code=${started.Code}&userId=${toGuid(admin.id)}`,
              approver,
            );
            expect(await approved.json()).toBe(true);
          }
          if (polls.length > 2) throw new Error("Approval never arrived.");
          await Bun.sleep(pollMs);
        }
        expect(polls.map((poll) => poll.Authenticated)).toEqual([false, true]);

        const exchange = () =>
          call("POST", "/Users/AuthenticateWithQuickConnect", androidTv, {
            Secret: started.Secret,
          });
        const loggedIn = await exchange();
        expect(loggedIn.status).toBe(200);
        const result = (await loggedIn.json()) as {
          AccessToken: string;
          SessionInfo: object;
        };
        expect(contractErrors("AuthenticationResult", result)).toEqual([]);
        expect(result.SessionInfo).toMatchObject({
          DeviceId: "tv-1",
          Client: "Android TV",
          UserId: toGuid(admin.id),
        });
        const me = await call(
          "GET",
          "/Users/Me",
          `${androidTv}, Token="${result.AccessToken}"`,
        );
        expect(me.status).toBe(200);

        expect((await exchange()).status).toBe(401);
        const spent = await call(
          "GET",
          `/QuickConnect/Connect?secret=${started.Secret}`,
          androidTv,
        );
        expect(spent.status).toBe(404);
      }),
    pollMs * 4,
  );

  test("unknown, expired and foreign requests fail", () =>
    withDatabase(async (db) => {
      const { call, approver } = await setup(db);
      const poll = (secret: string) =>
        call("GET", `/QuickConnect/Connect?secret=${secret}`, androidTv);
      const exchange = (secret: string) =>
        call("POST", "/Users/AuthenticateWithQuickConnect", androidTv, {
          Secret: secret,
        });
      const approve = (query: string) =>
        call("POST", `/QuickConnect/Authorize?${query}`, approver);
      const initiate = async () =>
        (await (
          await call("POST", "/QuickConnect/Initiate", androidTv)
        ).json()) as QuickConnectResult;

      const unknown = "A".repeat(43);
      expect((await poll(unknown)).status).toBe(404);
      expect((await exchange(unknown)).status).toBe(401);

      const approved = await initiate();
      const pending = await initiate();
      expect((await exchange(pending.Secret)).status).toBe(401);
      const foreign = await approve(
        `code=${pending.Code}&userId=${"0".repeat(32)}`,
      );
      expect(foreign.status).toBe(403);
      expect((await approve(`code=${approved.Code}`)).status).toBe(200);

      await db
        .update(quickConnectRequests)
        .set({ expiresAt: sql`now() - interval '1 second'` });
      expect((await poll(approved.Secret)).status).toBe(404);
      expect((await exchange(approved.Secret)).status).toBe(401);
      expect((await approve(`code=${pending.Code}`)).status).toBe(404);

      // Expired rows are swept, then one address may hold ten pending
      // requests, even when the last few arrive at once.
      for (let held = 0; held < 9; held++) await initiate();
      const racing = await Promise.all(
        Array.from({ length: 5 }, () =>
          call("POST", "/QuickConnect/Initiate", androidTv),
        ),
      );
      expect(racing.map((response) => response.status).sort()).toEqual([
        200, 429, 429, 429, 429,
      ]);
      const flooded = racing.find((response) => response.status === 429);
      expect(flooded?.headers.get("retry-after")).toBe("600");
    }));
});
