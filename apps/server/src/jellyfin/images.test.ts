import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHlsHandler } from "../api/hls.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { storeArtworkOriginal } from "../metadata/artwork-store.ts";
import { createJellyfinHandler } from "./http.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { fixturePng as png } from "./testing.ts";

const findroid =
  'MediaBrowser Client="Findroid", Version="0.15.4", DeviceId="pixel-1", Device="Pixel"';

describe.skipIf(!databaseUrl)("jellyfin images", () => {
  test("serves the selected poster without a token, and with one when artwork auth is on", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const root = await mkdtemp(join(tmpdir(), "thalia-images-"));
      try {
        await setupAdmin(db, { username: "mia", password: "secret-pass" });
        const [library] = await insertLibraries(db, {
          name: "Movies",
          medium: "movies",
          rootPath: root,
        });
        if (!library) throw new Error("Library insert returned no row.");
        const movie = await insertItem(db, {
          libraryId: library.id,
          kind: "movie",
          title: "Alien",
          canonicalFolder: "Alien (1979)",
          extension: {},
        });
        await mkdir(join(root, movie.canonicalFolder), { recursive: true });
        const poster = await storeArtworkOriginal(
          db,
          movie.id,
          { type: "poster", url: "https://image.example/poster.png" },
          (async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response(png)) as typeof fetch,
        );

        const handle = createJellyfinHandler(
          db,
          jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db)),
        );
        const send = async (
          path: string,
          headers: HeadersInit = {},
          options: { method?: string; body?: BodyInit } = {},
        ) => {
          const response = await handle(
            new Request(`http://thalia.test${path}`, {
              method:
                options.method ?? (path.startsWith("/Users/") ? "POST" : "GET"),
              headers: { "content-type": "application/json", ...headers },
              body:
                options.body ??
                (path.startsWith("/Users/")
                  ? JSON.stringify({ Username: "mia", Pw: "secret-pass" })
                  : undefined),
            }),
            "127.0.0.1",
          );
          if (response === undefined) throw new Error(`${path} unrouted`);
          return response;
        };
        const images = `/Items/${toGuid(movie.id)}/Images`;

        // Findroid builds image URLs with only a tag and no token.
        const anonymous = await send(
          `${images}/Primary?tag=${toGuid(poster.id)}&maxWidth=4`,
        );
        expect(anonymous.status).toBe(200);
        const { width } = await new Bun.Image(
          new Uint8Array(await anonymous.arrayBuffer()),
        ).metadata();
        expect(width).toBe(4);
        const etag = anonymous.headers.get("etag") ?? "";
        expect(
          (
            await send(`${images}/primary/0?MaxWidth=4`, {
              "If-None-Match": etag,
            })
          ).status,
        ).toBe(304);
        expect((await send(`${images}/Primary?fillWidth=2`)).status).toBe(200);
        expect((await send(`${images}/Primary/1`)).status).toBe(404);
        expect((await send(`${images}/Banner`)).status).toBe(404);
        expect((await send(`${images}/Backdrop`)).status).toBe(404);
        const head = await send(
          `${images}/Primary?maxWidth=4`,
          {},
          { method: "HEAD" },
        );
        expect(head.status).toBe(200);
        expect(head.headers.get("etag")).toBe(etag);
        expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
        expect(await head.text()).toBe("");
        const missingHead = await send(
          `${images}/Backdrop`,
          {},
          { method: "HEAD" },
        );
        expect(missingHead.status).toBe(404);
        expect(await missingHead.text()).toBe("");
        const jpeg = await send(
          `${images}/Primary/0/${toGuid(poster.id)}/Jpg/0/3/0/0`,
        );
        expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
        expect(
          await new Bun.Image(
            new Uint8Array(await jpeg.arrayBuffer()),
          ).metadata(),
        ).toMatchObject({ format: "jpeg", width: 3, height: 3 });
        const limited = await send(
          `${images}/Primary?width=7&maxWidth=4&maxHeight=2&format=Webp`,
        );
        expect(limited.headers.get("content-type")).toBe("image/webp");
        expect(
          await new Bun.Image(
            new Uint8Array(await limited.arrayBuffer()),
          ).metadata(),
        ).toMatchObject({ format: "webp", width: 2, height: 2 });

        await db
          .insert(settings)
          .values({ key: "auth", value: { artworkRequiresAuth: true } });
        expect((await send(`${images}/Primary`)).status).toBe(401);
        const login = (await (
          await send("/Users/AuthenticateByName", { Authorization: findroid })
        ).json()) as { AccessToken: string };
        const signedIn = await send(`${images}/Primary`, {
          Authorization: `${findroid}, Token="${login.AccessToken}"`,
        });
        expect(signedIn.status).toBe(200);
        const auth = { "X-Emby-Token": login.AccessToken };
        expect(await (await send(images, auth)).json()).toMatchObject([
          { ImageType: "Primary", Width: 8, Height: 8, Size: png.byteLength },
        ]);
        const uploaded = await send(
          `${images}/Primary/0`,
          { ...auth, "content-type": "image/png" },
          { method: "POST", body: png.toString("base64") },
        );
        expect(uploaded.status).toBe(204);
        expect(await Bun.file(join(root, poster.storageKey)).exists()).toBe(
          false,
        );
        expect((await send(`${images}/Primary`, auth)).status).toBe(200);
        expect(
          (
            await send(
              `${images}/Primary`,
              { ...auth, "content-type": "image/png" },
              { method: "POST", body: "invalid" },
            )
          ).status,
        ).toBe(400);
        expect(
          (
            await send(
              `${images}/Primary`,
              { ...auth, "content-type": "image/png" },
              { method: "POST", body: png },
            )
          ).status,
        ).toBe(204);
        for (const format of ["jpeg", "webp"] as const) {
          const original = await new Bun.Image(png)
            [format]({ quality: 100 })
            .bytes();
          expect(
            (
              await send(
                `${images}/Primary`,
                { ...auth, "content-type": `image/${format}` },
                { method: "POST", body: new Uint8Array(original) },
              )
            ).status,
          ).toBe(204);
          const low = await send(`${images}/Primary?quality=1`, auth);
          const high = await send(`${images}/Primary?quality=100`, auth);
          expect(low.headers.get("content-type")).toBe(`image/${format}`);
          expect(high.headers.get("content-type")).toBe(`image/${format}`);
          expect(Buffer.from(await low.arrayBuffer())).not.toEqual(
            Buffer.from(await high.arrayBuffer()),
          );
        }
        expect(
          (await send(`${images}/Primary`, auth, { method: "DELETE" })).status,
        ).toBe(204);
        expect(await (await send(images, auth)).json()).toEqual([]);
        expect((await send(`${images}/Primary`, auth)).status).toBe(404);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }));
});
