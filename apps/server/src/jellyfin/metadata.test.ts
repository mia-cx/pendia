import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import { artwork } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { updateLibrary } from "../libraries/service.ts";
import { withVideoFixture } from "../mediums/video-common/fixtures.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { setProviderKey } from "../providers/keys.ts";
import { createJellyfinHandler } from "./http.ts";
import { jellyfinRoutes } from "./routes.ts";
import { fixturePng, jellyfinLogin } from "./testing.ts";

describe.skipIf(!databaseUrl)("Jellyfin remote metadata", () => {
  test("searches configured providers, applies a chosen identity, and respects artwork replacement", () =>
    withDatabase((db) =>
      withVideoFixture(async (root) => {
        const seed = await seedBrowse(db);
        for (const library of [seed.films, seed.tv, seed.hidden])
          await updateLibrary(db, seed.admin.id, library.id, {
            roots: [{ id: library.rootId, path: join(root, library.id) }],
          });
        await mkdir(join(root, seed.films.id, "The Matrix"), {
          recursive: true,
        });
        await setProviderKey(db, seed.admin.id, "tmdb", "test-key");
        const requested: string[] = [];
        const request = (async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          requested.push(url.href);
          if (url.pathname === "/3/search/movie")
            return Response.json({
              results: [
                {
                  id: 777,
                  title: "Corrected Matrix",
                  release_date: "1999-03-31",
                },
              ],
            });
          if (url.pathname === "/3/movie/777")
            return Response.json({
              id: 777,
              title: "Corrected Matrix",
              overview: "Provider description",
              release_date: "1999-03-31",
              genres: [{ id: 1, name: "Action" }],
              credits: {
                cast: [
                  { id: 1, name: "Remote Actor", character: "Lead", order: 0 },
                ],
                crew: [],
              },
              external_ids: { imdb_id: "tt0777" },
              poster_path: "/selected.png",
              images: { posters: [{ file_path: "/alternate.png" }] },
            });
          if (
            url.hostname === "image.example" ||
            url.hostname === "image.tmdb.org"
          )
            return new Response(fixturePng);
          throw new Error(`Unexpected test request ${url.pathname}`);
        }) as typeof fetch;
        const handle = createJellyfinHandler(
          db,
          jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db), {
            request,
          }),
        );
        const send = (request: Request) => handle(request, "127.0.0.1");
        const admin = await jellyfinLogin(
          send,
          'MediaBrowser Client="Metadata", Device="Browser", DeviceId="metadata-admin"',
          "admin",
          "admin-pass",
        );
        const viewer = await jellyfinLogin(
          send,
          'MediaBrowser Client="Metadata", Device="Browser", DeviceId="metadata-viewer"',
        );
        const call = async (
          path: string,
          method = "GET",
          body?: unknown,
          token = admin,
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
          if (response === undefined) throw new Error("Missing route");
          return response;
        };
        const found = await call(
          "/Items/RemoteSearch/Movie",
          "POST",
          {
            searchInfo: { name: "Corrected Matrix", year: 1999 },
            itemId: seed.matrix.id,
          },
          viewer,
        );
        expect(found.status).toBe(200);
        const results = (await found.json()) as {
          Name: string;
          ProductionYear: number;
          ProviderIds: Record<string, string>;
          SearchProviderName: string;
        }[];
        expect(results).toEqual([
          {
            Name: "Corrected Matrix",
            ProductionYear: 1999,
            ProviderIds: { Tmdb: "777" },
            SearchProviderName: "tmdb",
          },
        ]);
        const pinned = await call(
          "/Items/RemoteSearch/Movie",
          "POST",
          { SearchInfo: { ProviderIds: { Tmdb: "777" } } },
          viewer,
        );
        expect(pinned.status).toBe(200);
        expect(await pinned.json()).toEqual(results);
        expect(
          (await call(`/Items/${seed.matrix.id}/RemoteImages/Providers`))
            .status,
        ).toBe(200);
        expect(
          (
            await call(
              `/Items/${seed.secret.id}/RemoteImages`,
              "GET",
              undefined,
              viewer,
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await call(
              `/Items/${seed.matrix.id}/RemoteImages/Download?type=Primary&imageUrl=https%3A%2F%2Fimage.example%2Foriginal.png`,
              "POST",
            )
          ).status,
        ).toBe(204);
        const [before] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.itemId, seed.matrix.id));
        if (before === undefined) throw new Error("Missing artwork");
        expect(
          (
            await call(
              `/Items/RemoteSearch/Apply/${seed.matrix.id}?replaceAllImages=false`,
              "POST",
              results[0],
            )
          ).status,
        ).toBe(204);
        const [kept] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.itemId, seed.matrix.id));
        expect(kept?.storageKey).toBe(before.storageKey);
        expect(
          await (await call(`/Items/${seed.matrix.id}`)).json(),
        ).toMatchObject({
          Name: "Corrected Matrix",
          Overview: "Provider description",
          Genres: ["Action"],
          ProviderIds: { Tmdb: "777", Imdb: "tt0777" },
          People: [{ Name: "Remote Actor", Role: "Lead" }],
        });
        const images = await (
          await call(
            `/Items/${seed.matrix.id}/RemoteImages?type=Primary&limit=1`,
          )
        ).json();
        expect(images).toMatchObject({
          TotalRecordCount: 2,
          Providers: ["tmdb"],
          Images: [
            {
              Url: "https://image.tmdb.org/t/p/original/selected.png",
              Type: "Primary",
            },
          ],
        });
        expect(
          (
            await call(
              `/Items/RemoteSearch/Apply/${seed.matrix.id}?replaceAllImages=true`,
              "POST",
              results[0],
            )
          ).status,
        ).toBe(204);
        const [replaced] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.itemId, seed.matrix.id));
        expect(replaced?.id).toBe(before.id);
        expect(replaced?.sourceUrl).toBe(
          "https://image.tmdb.org/t/p/original/selected.png",
        );
        expect(
          requested.filter(
            (value) => new URL(value).hostname === "image.tmdb.org",
          ),
        ).toHaveLength(1);
        expect(
          (
            await call(
              `/Items/RemoteSearch/Apply/${seed.matrix.id}`,
              "POST",
              results[0],
              viewer,
            )
          ).status,
        ).toBe(403);
      }),
    ));
});
