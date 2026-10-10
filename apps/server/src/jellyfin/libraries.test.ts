import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedBrowse } from "../api/view-fixtures.ts";
import { files, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { getLibrary, updateLibrary } from "../libraries/service.ts";
import { createJellyfinHandler } from "./http.ts";
import { requiredGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { jellyfinLogin } from "./testing.ts";

describe.skipIf(!databaseUrl)("Jellyfin library administration", () => {
  test("round-trips managed roots and metadata, and removes catalogue entries while retaining source media", () =>
    withDatabase(async (db) => {
      const root = await mkdtemp(join(tmpdir(), "jellyfin-library-"));
      try {
        const seed = await seedBrowse(db);
        for (const library of [seed.films, seed.tv, seed.hidden])
          await updateLibrary(db, seed.admin.id, library.id, {
            roots: [
              { id: library.rootId, path: join(root, `seed-${library.id}`) },
            ],
          });
        const handle = createJellyfinHandler(
          db,
          jellyfinRoutes(
            async () => new Response(),
            async () => new Response(),
          ),
        );
        const token = await jellyfinLogin(
          (request) => handle(request, "127.0.0.1"),
          'MediaBrowser Client="Library test", Device="Browser", DeviceId="library-test"',
          "admin",
          "admin-pass",
        );
        const call = async (path: string, method = "GET", body?: unknown) => {
          const response = await handle(
            new Request(`http://thalia.test${path}`, {
              method,
              headers: {
                "X-Emby-Token": token,
                "Content-Type": "application/json",
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
            "127.0.0.1",
          );
          expect(response?.status, path).toBe(method === "GET" ? 200 : 204);
          if (response === undefined) throw new Error("Missing route");
          return method === "GET" ? response.json() : undefined;
        };
        await call(
          `/Library/VirtualFolders?name=Managed&collectionType=movies&paths=${encodeURIComponent(`${root}/first`)}`,
          "POST",
        );
        const folders = (await call("/Library/VirtualFolders")) as {
          Name: string;
          ItemId: string;
          Locations: string[];
          LibraryOptions: { PreferredMetadataLanguage: string };
        }[];
        const library = folders.find((folder) => folder.Name === "Managed");
        if (library === undefined) throw new Error("Missing library");
        expect(library.Locations).toEqual([`${root}/first`]);
        await call("/Library/VirtualFolders/Paths", "POST", {
          Name: "Managed",
          PathInfo: { Path: `${root}/second` },
        });
        await call(
          `/Library/VirtualFolders/Paths?name=Managed&path=${encodeURIComponent(`${root}/first`)}`,
          "DELETE",
        );
        await call("/Library/VirtualFolders/LibraryOptions", "POST", {
          id: library.ItemId,
          libraryOptions: {
            preferredMetadataLanguage: "nl",
            pathInfos: [{ path: `${root}/second` }],
          },
        });
        await call(
          "/Library/VirtualFolders/Name?name=Managed&newName=Renamed",
          "POST",
        );
        expect(
          ((await call("/Library/VirtualFolders")) as typeof folders).find(
            (folder) => folder.ItemId === library.ItemId,
          ),
        ).toMatchObject({
          Name: "Renamed",
          Locations: [`${root}/second`],
          LibraryOptions: { PreferredMetadataLanguage: "nl" },
        });
        expect(await call("/Library/PhysicalPaths")).toContain(
          `${root}/second`,
        );
        expect(
          await call(`/Items/${library.ItemId}/MetadataEditor`),
        ).toMatchObject({ ContentType: "movies" });

        await call(`/Items/${seed.matrix.id}`, "POST", {
          Name: "Edited Matrix",
          Overview: "Manual description",
          ProductionYear: 2003,
          PremiereDate: "2003-05-15T00:00:00Z",
          Genres: ["Science Fiction"],
          Tags: ["Edited"],
          ProviderIds: {},
          People: [{ Name: "Example Actor", Type: "Actor", Role: "Hero" }],
        });
        const detail = (await call(`/Items/${seed.matrix.id}`)) as {
          People: { Id: string }[];
        };
        expect(detail).toMatchObject({
          Name: "Edited Matrix",
          Overview: "Manual description",
          ProductionYear: 2003,
          PremiereDate: "2003-05-15T00:00:00.0000000Z",
          Genres: ["Science Fiction"],
          Tags: ["Edited"],
          ProviderIds: {},
          People: [{ Name: "Example Actor", Role: "Hero", Type: "Actor" }],
        });
        const person = detail.People[0];
        if (person === undefined) throw new Error("Missing actor");
        await call(`/Items/${person.Id}`, "POST", {
          Name: "Renamed Actor",
          Overview: "Biography",
          ProviderIds: { Tmdb: "person-1" },
        });
        expect(await call(`/Items/${person.Id}`)).toMatchObject({
          Name: "Renamed Actor",
          Overview: "Biography",
          ProviderIds: { Tmdb: "person-1" },
        });
        expect(await call(`/Items/${person.Id}/MetadataEditor`)).toMatchObject({
          ExternalIdInfos: [{ Key: "tmdb" }],
          ContentType: null,
        });

        const managed = await getLibrary(
          db,
          seed.admin.id,
          requiredGuid(library.ItemId),
        );
        const folder = managed.roots[0];
        if (folder === undefined) throw new Error("Missing root");
        await mkdir(folder.path, { recursive: true });
        const sourcePath = join(folder.path, "source.mp4");
        await Bun.write(sourcePath, "source");
        const item = await insertItem(db, {
          libraryId: managed.id,
          kind: "movie",
          title: "Remove from catalogue",
          canonicalFolder: ".",
          extension: {},
        });
        const [version] = await db
          .insert(versions)
          .values({
            itemId: item.id,
            itemKind: "movie",
            libraryId: managed.id,
            label: "Source",
            format: "video",
            bytes: 6n,
          })
          .returning();
        if (version === undefined) throw new Error("Missing version");
        await db.insert(files).values({
          versionId: version.id,
          itemId: item.id,
          libraryId: managed.id,
          rootId: folder.id,
          path: "source.mp4",
          order: 0,
          bytes: 6n,
          modifiedAt: new Date(),
        });
        await call(`/Items/${item.id}`, "DELETE");
        expect(await Bun.file(sourcePath).text()).toBe("source");
        expect(
          (
            await handle(
              new Request(`http://thalia.test/Items/${item.id}`, {
                headers: { "X-Emby-Token": token },
              }),
              "127.0.0.1",
            )
          )?.status,
        ).toBe(404);
        await call(
          `/Items?ids=${seed.show.id},${seed.episodeOne.id}`,
          "DELETE",
        );
        expect(
          (
            await handle(
              new Request(`http://thalia.test/Items/${seed.episodeOne.id}`, {
                headers: { "X-Emby-Token": token },
              }),
              "127.0.0.1",
            )
          )?.status,
        ).toBe(404);
        await call("/Library/VirtualFolders?name=Renamed", "DELETE");
        expect(
          ((await call("/Library/VirtualFolders")) as typeof folders).some(
            (folder) => folder.ItemId === library.ItemId,
          ),
        ).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }));
});
