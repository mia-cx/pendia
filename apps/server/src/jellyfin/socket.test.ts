import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { runScanJob } from "../libraries/jobs.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { toGuid } from "./request.ts";
import { contractErrors, jellyfinLogin, seedMovies } from "./testing.ts";

const androidTv =
  'MediaBrowser Client="Android TV", Device="Shield", DeviceId="shield-1", Version="0.18.0"';
const swiftfin =
  'MediaBrowser Client="Swiftfin iOS", Device="iPhone", DeviceId="swiftfin-1", Version="1.3"';

type Message = { MessageType: string; MessageId: string; Data?: unknown };

// Bun's client sends headers, as the Kotlin SDK does; the DOM typings the
// project loads only know the protocols argument.
const HeaderSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

/** Opens a socket that records every message, with a wait for the next one of a type. */
function connect(url: string, headers: Record<string, string> = {}) {
  const socket = new HeaderSocket(url, { headers });
  const received: Message[] = [];
  let seen = 0;
  socket.addEventListener("message", (event) => {
    received.push(JSON.parse(String(event.data)));
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("No socket.")));
  });
  return {
    socket,
    received,
    opened,
    /** Resolves with the next message of a type after the last one taken. */
    async next(type: string) {
      for (let waited = 0; waited < 10_000; waited += 20) {
        const index = received.findIndex(
          (message, at) => at >= seen && message.MessageType === type,
        );
        const found = received[index];
        if (found !== undefined) {
          seen = index + 1;
          return found;
        }
        await Bun.sleep(20);
      }
      throw new Error(`No ${type} arrived.`);
    },
  };
}

describe.skipIf(!databaseUrl)("jellyfin socket", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "thalia-jellyfin-socket-"));
    await mkdir(join(root, "Clip (2026)"));
    await createVideoFixture(join(root, "Clip (2026)", "Clip.mkv"), {
      width: 160,
      height: 90,
    });
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("pushes LibraryChanged after a scan and UserDataChanged to the owner", () =>
    withDatabase(async (db, url) => {
      const { library, movies } = await seedMovies(db, root, ["Clip"]);
      const itemId = movies.get("Clip")?.itemId ?? "";
      const thalia = await startThalia("api", {
        databaseUrl: url,
        port: 0,
        brokerOptions: { pollIntervalMs: 200 },
      });
      const sockets: WebSocket[] = [];
      try {
        const base = `http://127.0.0.1:${thalia.apiServer?.port}`;
        const send = (request: Request) =>
          fetch(new URL(new URL(request.url).pathname, base), request);
        const viewerToken = await jellyfinLogin(send, androidTv);
        const adminToken = await jellyfinLogin(
          send,
          swiftfin,
          "admin",
          "admin-pass",
        );
        const ws = base.replace("http", "ws");

        // Android TV authenticates by header, Swiftfin by query.
        const tv = connect(`${ws}/socket`, {
          authorization: `${androidTv}, Token="${viewerToken}"`,
        });
        const admin = connect(
          `${ws}/socket?api_key=${adminToken}&deviceId=swiftfin-1`,
        );
        sockets.push(tv.socket, admin.socket);
        await Promise.all([tv.opened, admin.opened]);

        const force = await tv.next("ForceKeepAlive");
        expect(force).toMatchObject({ Data: 60 });
        expect(force.MessageId).toMatch(/^[0-9a-f]{32}$/);
        tv.socket.send(JSON.stringify({ MessageType: "KeepAlive" }));
        await tv.next("KeepAlive");

        await runScanJob(
          db,
          { type: "scan", libraryId: library.id, path: "Clip (2026)" },
          { id: crypto.randomUUID() },
        );
        for (const client of [tv, admin])
          expect((await client.next("LibraryChanged")).Data).toMatchObject({
            CollectionFolders: [toGuid(library.id)],
            ItemsUpdated: [toGuid(library.id)],
          });

        const favourite = await fetch(
          `${base}/UserFavoriteItems/${toGuid(itemId)}`,
          {
            method: "POST",
            headers: { authorization: `${androidTv}, Token="${viewerToken}"` },
          },
        );
        expect(favourite.status).toBe(200);
        const changed = (await tv.next("UserDataChanged")).Data as {
          UserId: string;
          UserDataList: object[];
        };
        expect(changed.UserDataList).toHaveLength(1);
        expect(
          contractErrors("UserItemDataDto", changed.UserDataList[0]),
        ).toEqual([]);
        expect(changed.UserDataList[0]).toMatchObject({
          ItemId: toGuid(itemId),
          IsFavorite: true,
        });

        // Events arrive in order, so the admin's own mark proves the
        // viewer's never reached it.
        await fetch(`${base}/UserPlayedItems/${toGuid(itemId)}`, {
          method: "POST",
          headers: { authorization: `${swiftfin}, Token="${adminToken}"` },
        });
        const own = (await admin.next("UserDataChanged")).Data as {
          UserDataList: object[];
        };
        expect(own.UserDataList[0]).toMatchObject({
          Played: true,
          IsFavorite: false,
        });
        expect(
          admin.received.filter(
            (message) => message.MessageType === "UserDataChanged",
          ),
        ).toHaveLength(1);

        expect((await fetch(`${base}/socket?api_key=wrong`)).status).toBe(401);
        expect((await fetch(`${base}/socket`)).status).toBe(401);
        expect(
          (await fetch(`${base}/Socket?ApiKey=${viewerToken}`)).status,
        ).toBe(400);
      } finally {
        for (const socket of sockets) socket.close();
        await thalia.stop();
      }
    }));
});
