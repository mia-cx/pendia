import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import type { Database } from "../db/client.ts";
import { progress, sessionRegistry, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { continueWatching } from "../playback/marks.ts";
import { createJellyfinHandler } from "./http.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { contractErrors, jellyfinLogin } from "./testing.ts";

const findroid =
  'MediaBrowser Client="Findroid", Version="0.15.4", Device="Pixel", DeviceId="findroid-1"';
const kodi =
  'MediaBrowser Client="Kodi", Device="htpc", DeviceId="kodi-1", Version="1.0"';

const ticks = (seconds: number) => seconds * 10_000_000;

async function client(db: Database, header: string) {
  const handle = createJellyfinHandler(
    db,
    jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
  );
  const send = async (request: Request) => {
    const response = await handle(request, "127.0.0.1");
    if (response === undefined) throw new Error("Unrouted.");
    return response;
  };
  const token = await jellyfinLogin(send, header);
  return (method: string, path: string, body?: object) =>
    send(
      new Request(`http://thalia.test${path}`, {
        method,
        headers: {
          authorization: `${header}, Token="${token}"`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
}

describe.skipIf(!databaseUrl)("jellyfin progress and marks", () => {
  test("the progress trio as Findroid and Kodi send it lands in continue watching", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      await db.insert(versions).values({
        itemId: s.arrival.id,
        itemKind: "movie",
        libraryId: s.films.id,
        label: "4K",
        format: "video",
        bytes: 1n,
        durationSeconds: 7000,
      });
      const call = await client(db, findroid);
      const item = toGuid(s.arrival.id);

      // Findroid's bodies, with no PlaySessionId at all.
      const state = {
        ItemId: item,
        CanSeek: true,
        IsPaused: false,
        IsMuted: false,
        PlayMethod: "DirectPlay",
        RepeatMode: "RepeatNone",
        PlaybackOrder: "Default",
      };
      expect((await call("POST", "/Sessions/Playing", state)).status).toBe(204);
      expect(
        (
          await call("POST", "/Sessions/Playing/Progress", {
            ...state,
            PositionTicks: ticks(1200),
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await call("POST", "/Sessions/Playing/Stopped", {
            ...state,
            PositionTicks: ticks(1500),
          })
        ).status,
      ).toBe(204);
      const [session, ...others] = await db
        .select()
        .from(sessionRegistry)
        .where(eq(sessionRegistry.itemId, s.arrival.id));
      expect(others).toEqual([]);
      expect(session).toMatchObject({
        userId: s.viewer.id,
        playMethod: "direct-play",
        state: "stopped",
      });
      const shelf = await continueWatching(db, s.viewer.id, {});
      expect(shelf.items.map((entry) => entry.item.id)).toContain(s.arrival.id);
      expect(
        shelf.items.find((entry) => entry.item.id === s.arrival.id)?.progress,
      ).toMatchObject({ positionSeconds: 1500, completed: false });

      // Kodi names its session and stops past the end; the play finishes.
      const kodiCall = await client(db, kodi);
      const start = {
        QueueableMediaTypes: "Video,Audio",
        CanSeek: true,
        ItemId: toGuid(s.matrix.id),
        MediaSourceId: toGuid(s.matrix.id),
        PlayMethod: "DirectPlay",
        VolumeLevel: 100,
        PositionTicks: 0,
        IsPaused: false,
        IsMuted: false,
        PlaySessionId: "0123456789abcdef0123456789abcdef",
        AudioStreamIndex: 1,
        SubtitleStreamIndex: 2,
      };
      expect((await kodiCall("POST", "/Sessions/Playing", start)).status).toBe(
        204,
      );
      const stopped = await kodiCall("POST", "/Sessions/Playing/Stopped", {
        ItemId: start.ItemId,
        MediaSourceId: start.MediaSourceId,
        PositionTicks: ticks(8200),
        PlaySessionId: start.PlaySessionId,
      });
      expect(stopped.status).toBe(204);
      const after = await continueWatching(db, s.viewer.id, {});
      expect(after.items.map((entry) => entry.item.id)).toEqual([s.arrival.id]);
      const detail = (await (
        await kodiCall("GET", `/Items/${toGuid(s.matrix.id)}`)
      ).json()) as { UserData: object };
      expect(detail.UserData).toMatchObject({ Played: true, PlayCount: 1 });

      // A report on an Item the caller cannot see fails like a missing one.
      const hidden = await call("POST", "/Sessions/Playing", {
        ItemId: toGuid(s.secret.id),
      });
      expect(hidden.status).toBe(403);
    }));

  test("reports stay on their own device and a stopped play counts once", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      const item = toGuid(s.matrix.id);
      const states = async () =>
        (
          await db
            .select({ id: sessionRegistry.id, state: sessionRegistry.state })
            .from(sessionRegistry)
            .where(eq(sessionRegistry.itemId, s.matrix.id))
            .orderBy(sessionRegistry.createdAt)
        ).map((row) => row.state);
      const playCount = async (call: Awaited<ReturnType<typeof client>>) =>
        (
          (await (await call("GET", `/Items/${item}`)).json()) as {
            UserData: { PlayCount: number };
          }
        ).UserData.PlayCount;

      // The same account plays the movie on a TV, then reports from a phone
      // without naming a session, as Findroid does.
      const tv = await client(db, kodi);
      const phone = await client(db, findroid);
      await tv("POST", "/Sessions/Playing", { ItemId: item, PositionTicks: 0 });
      await phone("POST", "/Sessions/Playing", {
        ItemId: item,
        PositionTicks: 0,
      });
      await phone("POST", "/Sessions/Playing/Stopped", {
        ItemId: item,
        PositionTicks: ticks(60),
      });
      expect(await states()).toEqual(["playing", "stopped"]);
      expect(
        (
          await tv("POST", "/Sessions/Playing/Progress", {
            ItemId: item,
            PositionTicks: ticks(15),
            IsPaused: true,
            VolumeLevel: 35,
          })
        ).status,
      ).toBe(204);
      expect(
        (await tv("POST", `/Sessions/Viewing?itemId=${item}`)).status,
      ).toBe(204);
      const active = (await (await tv("GET", "/Sessions")).json()) as {
        DeviceId: string;
        NowPlayingItem: { Id: string } | null;
        NowViewingItem: { Id: string } | null;
        PlayState: object;
      }[];
      expect(
        active.find((session) => session.DeviceId === "kodi-1"),
      ).toMatchObject({
        NowPlayingItem: { Id: item },
        NowViewingItem: { Id: item },
        PlayState: {
          PositionTicks: ticks(15),
          IsPaused: true,
          VolumeLevel: 35,
        },
      });
      expect(
        active.find((session) => session.DeviceId === "findroid-1")
          ?.NowPlayingItem,
      ).toBeNull();
      // The sessions dashboard names each device.
      expect(
        (
          await db
            .select({
              client: sessionRegistry.clientName,
              device: sessionRegistry.deviceName,
            })
            .from(sessionRegistry)
            .orderBy(sessionRegistry.createdAt)
        ).map((row) => [row.client, row.device]),
      ).toEqual([
        ["Kodi", "htpc"],
        ["Findroid", "Pixel"],
      ]);

      // A retried stop for a named play changes nothing.
      const [tvSession] = await db
        .select({ id: sessionRegistry.id })
        .from(sessionRegistry)
        .where(eq(sessionRegistry.state, "playing"));
      const stop = {
        ItemId: item,
        PlaySessionId: toGuid(tvSession?.id ?? ""),
        PositionTicks: ticks(8000),
      };
      expect(
        (
          await tv(
            "POST",
            `/Sessions/Playing/Ping?playSessionId=${toGuid(tvSession?.id ?? "")}`,
          )
        ).status,
      ).toBe(204);
      expect((await tv("POST", "/Sessions/Playing/Stopped", stop)).status).toBe(
        204,
      );
      const counted = await playCount(tv);
      expect((await tv("POST", "/Sessions/Playing/Stopped", stop)).status).toBe(
        204,
      );
      expect(await states()).toEqual(["stopped", "stopped"]);
      expect(await playCount(tv)).toBe(counted);

      // A late stop for that play leaves a newer play on the same device alone.
      await tv("POST", "/Sessions/Playing", { ItemId: item, PositionTicks: 0 });
      expect((await tv("POST", "/Sessions/Playing/Stopped", stop)).status).toBe(
        204,
      );
      expect(await states()).toEqual(["stopped", "stopped", "playing"]);
    }));

  test("played and favourite marks answer UserItemDataDto", () =>
    withDatabase(async (db) => {
      const s = await seedBrowse(db);
      await db.insert(versions).values(
        [s.episodeOne, s.episodeTwo].map((episode) => ({
          itemId: episode.id,
          itemKind: "episode" as const,
          libraryId: s.tv.id,
          label: "1080p",
          format: "video" as const,
          bytes: 1n,
          durationSeconds: 3000,
        })),
      );
      const call = await client(db, findroid);
      const show = toGuid(s.show.id);
      const episodes = async () =>
        (
          (await (await call("GET", `/Shows/${show}/Episodes`)).json()) as {
            Items: { Name: string; UserData: { Played: boolean } }[];
          }
        ).Items.map((episode) => [episode.Name, episode.UserData.Played]);

      const played = await call("POST", `/UserPlayedItems/${show}`);
      expect(played.status).toBe(200);
      const playedData = await played.json();
      expect(contractErrors("UserItemDataDto", playedData)).toEqual([]);
      expect(playedData).toMatchObject({ ItemId: show, Key: show });
      expect(await episodes()).toEqual([
        ["Good News About Hell", true],
        ["Half Loop", true],
      ]);
      const unplayed = await call("DELETE", `/UserPlayedItems/${show}`);
      expect(await unplayed.json()).toMatchObject({
        Played: false,
        PlayCount: 0,
        PlaybackPositionTicks: 0,
      });
      expect(await episodes()).toEqual([
        ["Good News About Hell", false],
        ["Half Loop", false],
      ]);

      const matrix = toGuid(s.matrix.id);
      const [selected] = await db
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.itemId, s.matrix.id));
      await db.insert(versions).values({
        itemId: s.matrix.id,
        itemKind: "movie",
        libraryId: s.films.id,
        label: "000-short",
        format: "video",
        bytes: 1n,
        durationSeconds: 10,
      });
      await db
        .update(progress)
        .set({ versionId: selected?.id, playedAt: null })
        .where(
          and(
            eq(progress.userId, s.viewer.id),
            eq(progress.itemId, s.matrix.id),
          ),
        );
      expect(
        (
          await call("POST", `/UserItems/${matrix}/UserData`, {
            PlaybackPositionTicks: ticks(321),
          })
        ).status,
      ).toBe(200);
      expect(
        (await continueWatching(db, s.viewer.id, {})).items.find(
          (item) => item.item.id === s.matrix.id,
        )?.progress,
      ).toMatchObject({
        versionId: selected?.id,
        positionSeconds: 321,
      });
      const updated = await call("POST", `/UserItems/${matrix}/UserData`, {
        PlaybackPositionTicks: ticks(321),
        PlayCount: 4,
        Played: false,
        IsFavorite: true,
        Rating: 8.5,
        Likes: false,
        LastPlayedDate: "2024-01-02T03:04:05Z",
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        PlaybackPositionTicks: ticks(321),
        PlayCount: 4,
        Rating: 8.5,
        Likes: false,
        LastPlayedDate: "2024-01-02T03:04:05.000Z",
      });
      expect(
        await (
          await call("POST", `/UserItems/${matrix}/Rating?likes=true`)
        ).json(),
      ).toMatchObject({ Rating: 8.5, Likes: true });
      expect(
        await (await call("DELETE", `/UserItems/${matrix}/Rating`)).json(),
      ).toMatchObject({ Rating: 8.5, Likes: null });
      expect(
        (
          await call(
            "GET",
            `/UserItems/${matrix}/UserData?userId=${toGuid(s.admin.id)}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call("POST", `/UserItems/${matrix}/UserData`, {
            PlaybackPositionTicks: -1,
          })
        ).status,
      ).toBe(400);
      const favourite = await call("POST", `/UserFavoriteItems/${matrix}`);
      const favouriteData = await favourite.json();
      expect(contractErrors("UserItemDataDto", favouriteData)).toEqual([]);
      expect(favouriteData).toMatchObject({
        IsFavorite: true,
        PlaybackPositionTicks: ticks(321),
      });
      expect(
        await (await call("DELETE", `/UserFavoriteItems/${matrix}`)).json(),
      ).toMatchObject({ IsFavorite: false });

      const denied = await call(
        "POST",
        `/UserFavoriteItems/${toGuid(s.secret.id)}`,
      );
      expect(denied.status).toBe(403);
    }));
});
