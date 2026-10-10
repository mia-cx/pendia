import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MetadataProvider } from "@thalia/plugin-api";
import { and, eq, inArray } from "drizzle-orm";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import { artwork, items, providerIds } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { updateLibrary } from "../libraries/service.ts";
import { withVideoFixture } from "../mediums/video-common/fixtures.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { queueProviderFetch, registerMetadataJobs } from "../metadata/jobs.ts";
import { removeProviderKey, setProviderKey } from "../providers/keys.ts";
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
        let artworkAvailable = true;
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
              poster_path: artworkAvailable ? "/selected.png" : null,
              images: {
                posters: artworkAvailable
                  ? [{ file_path: "/alternate.png" }]
                  : [],
              },
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
          .where(
            and(eq(artwork.itemId, seed.matrix.id), eq(artwork.type, "poster")),
          );
        if (before === undefined) throw new Error("Missing artwork");
        expect(
          (
            await call(
              `/Items/${seed.matrix.id}/RemoteImages/Download?type=Logo&imageUrl=https%3A%2F%2Fimage.example%2Flogo.png`,
              "POST",
            )
          ).status,
        ).toBe(204);
        const [logo] = await db
          .select()
          .from(artwork)
          .where(
            and(eq(artwork.itemId, seed.matrix.id), eq(artwork.type, "logo")),
          );
        if (logo === undefined) throw new Error("Missing logo");
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
          .where(
            and(eq(artwork.itemId, seed.matrix.id), eq(artwork.type, "poster")),
          );
        expect(kept?.storageKey).toBe(before.storageKey);
        expect(
          await db.select().from(artwork).where(eq(artwork.id, logo.id)),
        ).toHaveLength(1);
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
          .where(
            and(eq(artwork.itemId, seed.matrix.id), eq(artwork.type, "poster")),
          );
        expect(replaced?.id).toBe(before.id);
        expect(replaced?.sourceUrl).toBe(
          "https://image.tmdb.org/t/p/original/selected.png",
        );
        expect(
          await db.select().from(artwork).where(eq(artwork.id, logo.id)),
        ).toHaveLength(0);
        expect(
          await Bun.file(join(root, seed.films.id, logo.storageKey)).exists(),
        ).toBe(false);
        expect(
          requested.filter(
            (value) => new URL(value).hostname === "image.tmdb.org",
          ),
        ).toHaveLength(1);
        if (replaced === undefined) throw new Error("Missing replaced artwork");
        artworkAvailable = false;
        expect(
          (
            await call(
              `/Items/RemoteSearch/Apply/${seed.matrix.id}?replaceAllImages=false`,
              "POST",
              results[0],
            )
          ).status,
        ).toBe(204);
        expect(
          await db
            .select()
            .from(artwork)
            .where(eq(artwork.itemId, seed.matrix.id)),
        ).toHaveLength(1);
        expect(
          (
            await call(
              `/Items/RemoteSearch/Apply/${seed.matrix.id}?replaceAllImages=true`,
              "POST",
              results[0],
            )
          ).status,
        ).toBe(204);
        expect(
          await db
            .select()
            .from(artwork)
            .where(eq(artwork.itemId, seed.matrix.id)),
        ).toHaveLength(0);
        expect(
          await Bun.file(
            join(root, seed.films.id, replaced.storageKey),
          ).exists(),
        ).toBe(false);
        expect(
          (
            await call(
              `/Items/${seed.matrix.id}/RemoteImages/Download?type=Primary&imageUrl=https%3A%2F%2Fimage.example%2Fkept.png`,
              "POST",
            )
          ).status,
        ).toBe(204);
        const [retained] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.itemId, seed.matrix.id));
        if (retained === undefined) throw new Error("Missing retained artwork");
        const registry = createJobRegistry();
        registerMetadataJobs(db, registry, request);
        const queue = createJobQueue(db);
        for (const available of [false, true]) {
          artworkAvailable = available;
          await removeProviderKey(db, seed.admin.id, "tmdb");
          await queueProviderFetch(db, seed.matrix.id);
          expect(
            (
              await call(
                `/Items/RemoteSearch/Apply/${seed.matrix.id}?replaceAllImages=false`,
                "POST",
                results[0],
              )
            ).status,
          ).toBe(204);
          await setProviderKey(db, seed.admin.id, "tmdb", "test-key");
          const job = await queue.claim(["provider-fetch"]);
          if (job === undefined) throw new Error("Missing deferred fetch");
          expect(job.payload).toMatchObject({
            artworkPolicy: "keep",
            provider: "tmdb",
          });
          await registry.run(job);
          await queue.complete(job);
          const [kept] = await db
            .select()
            .from(artwork)
            .where(eq(artwork.itemId, seed.matrix.id));
          expect(kept?.storageKey).toBe(retained.storageKey);
          expect(kept?.sourceUrl).toBe(retained.sourceUrl);
        }
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

  test("refreshes derived Show identities while retaining pinned children and selected artwork", () =>
    withDatabase((db) =>
      withVideoFixture(async (root) => {
        const seed = await seedBrowse(db);
        for (const library of [seed.films, seed.tv, seed.hidden])
          await updateLibrary(db, seed.admin.id, library.id, {
            roots: [{ id: library.rootId, path: join(root, library.id) }],
          });
        await mkdir(join(root, seed.tv.id, "Severance"), { recursive: true });
        await db
          .update(items)
          .set({ metadataState: "matched" })
          .where(
            inArray(items.id, [
              seed.show.id,
              seed.seasonOne.id,
              seed.episodeOne.id,
              seed.episodeTwo.id,
            ]),
          );
        await db.insert(providerIds).values([
          { itemId: seed.show.id, provider: "mock", value: "old-show" },
          {
            itemId: seed.seasonOne.id,
            provider: "mock",
            value: "old-season",
            metadataDerived: true,
          },
          {
            itemId: seed.episodeOne.id,
            provider: "mock",
            value: "old-episode",
            metadataDerived: true,
          },
          {
            itemId: seed.episodeTwo.id,
            provider: "other",
            value: "pinned-episode",
            metadataDerived: false,
          },
        ]);
        const searched: Parameters<MetadataProvider["search"]>[0][] = [];
        const provider: MetadataProvider = {
          id: "mock",
          kinds: ["show", "season", "episode"],
          async search(query) {
            searched.push(query);
            return [
              {
                providerId: `new-${query.kind}-${query.show?.episodeNumber ?? query.show?.seasonNumber}`,
                title: "New child",
                year: 2026,
                confidence: 1,
              },
            ];
          },
          async fetch({ providerId }) {
            return {
              title: `Remote ${providerId}`,
              overview: null,
              year: 2026,
              contentRating: null,
              genres: [],
              credits: [],
              artwork: [
                { type: "poster", url: "https://image.example/new.png" },
              ],
              providerIds: { mock: providerId },
              status: "ended",
            };
          },
        };
        const other: MetadataProvider = {
          ...provider,
          id: "other",
          async search() {
            throw new Error("An explicitly pinned child must not be searched");
          },
          async fetch({ providerId }) {
            const result = await provider.fetch({
              providerId,
              kind: "episode",
            });
            if (result === null) return null;
            return {
              ...result,
              title: `Other ${providerId}`,
              providerIds: { other: providerId },
            };
          },
        };
        const plugins = { metadataProviders: async () => [provider, other] };
        const request = (async (_input: RequestInfo | URL) =>
          new Response(fixturePng)) as typeof fetch;
        const handle = createJellyfinHandler(
          db,
          jellyfinRoutes(createArtworkHandler(db), createHlsHandler(db), {
            plugins,
            request,
          }),
        );
        const send = (request: Request) => handle(request, "127.0.0.1");
        const token = await jellyfinLogin(
          send,
          'MediaBrowser Client="Metadata", Device="Browser", DeviceId="metadata-show"',
          "admin",
          "admin-pass",
        );
        await queueProviderFetch(db, seed.show.id);
        const response = await send(
          new Request(
            `http://thalia.test/Items/RemoteSearch/Apply/${seed.show.id}?replaceAllImages=false`,
            {
              method: "POST",
              headers: {
                "X-Emby-Token": token,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                ProviderIds: { Mock: "new-show" },
                SearchProviderName: "mock",
              }),
            },
          ),
        );
        expect(response?.status).toBe(204);
        const registry = createJobRegistry();
        registerMetadataJobs(db, registry, request, plugins);
        const queue = createJobQueue(db);
        const job = await queue.claim(["provider-fetch"]);
        if (job === undefined) throw new Error("Missing Show refresh");
        expect(job.payload).toMatchObject({
          provider: "mock",
          artworkPolicy: "keep",
        });
        await registry.run(job);
        await queue.complete(job);
        const ids = await db
          .select({
            itemId: providerIds.itemId,
            value: providerIds.value,
            derived: providerIds.metadataDerived,
          })
          .from(providerIds)
          .where(inArray(providerIds.provider, ["mock", "other"]));
        expect(ids).toContainEqual({
          itemId: seed.show.id,
          value: "new-show",
          derived: false,
        });
        expect(
          ids.filter((row) => row.itemId === seed.episodeTwo.id),
        ).toHaveLength(1);
        const [pinnedChild] = await db
          .select()
          .from(items)
          .where(eq(items.id, seed.episodeTwo.id));
        expect(pinnedChild?.title).toBe("Other pinned-episode");
        expect(ids).toContainEqual({
          itemId: seed.seasonOne.id,
          value: "new-season-1",
          derived: true,
        });
        expect(ids).toContainEqual({
          itemId: seed.episodeOne.id,
          value: "new-episode-1",
          derived: true,
        });
        expect(ids).toContainEqual({
          itemId: seed.episodeTwo.id,
          value: "pinned-episode",
          derived: false,
        });
        expect(
          searched.every(
            (query) => query.show?.providerIds.mock === "new-show",
          ),
        ).toBe(true);
        expect(searched.some((query) => query.show?.episodeNumber === 2)).toBe(
          false,
        );
        const [poster] = await db
          .select()
          .from(artwork)
          .where(eq(artwork.id, seed.showPoster.id));
        expect(poster?.storageKey).toBe(seed.showPoster.storageKey);
      }),
    ));
});
