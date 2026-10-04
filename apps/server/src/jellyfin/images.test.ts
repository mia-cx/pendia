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

// An 8 by 8 PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP4y8CAFWEXHbQSAPZwP0G2GkFNAAAAAElFTkSuQmCC",
  "base64",
);
const findroid =
  'MediaBrowser Client="Findroid", Version="0.15.4", DeviceId="pixel-1", Device="Pixel"';

describe.skipIf(!databaseUrl)("jellyfin images", () => {
  test("serves the selected poster without a token, and with one when artwork auth is on", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const root = await mkdtemp(join(tmpdir(), "pendia-images-"));
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
        const send = async (path: string, headers: HeadersInit = {}) => {
          const response = await handle(
            new Request(`http://pendia.test${path}`, {
              method: path.startsWith("/Users/") ? "POST" : "GET",
              headers: { "content-type": "application/json", ...headers },
              body: path.startsWith("/Users/")
                ? JSON.stringify({ Username: "mia", Pw: "secret-pass" })
                : undefined,
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
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }));
});
