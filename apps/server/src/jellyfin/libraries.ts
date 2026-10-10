import { isAbsolute } from "node:path";
import { listItemViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import type { JsonObject, JsonValue } from "../db/schema/common.ts";
import {
  createLibrary,
  deleteLibrary,
  getLibrary,
  listLibraries,
  RootError,
  readLibraryPreference,
  rescanLibraries,
  scanLibrary,
  updateLibrary,
  writeLibraryPreference,
} from "../libraries/service.ts";
import {
  editContributorMetadata,
  editItemMetadata,
  type ItemMetadataEdit,
  readContributorMetadata,
  removeCatalogueItems,
} from "../metadata/edit.ts";
import { refreshItem } from "../metadata/jobs.ts";
import { json, noContent, type Route, type UserContext } from "./http.ts";
import { providerIdsDto } from "./items.ts";
import { defaultValue, openapi } from "./openapi.ts";
import { requiredGuid, toGuid } from "./request.ts";
import { readDto } from "./schema.ts";

const object = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
const pathsOf = (options: JsonObject) =>
  Array.isArray(options.PathInfos)
    ? options.PathInfos.flatMap((value) =>
        typeof object(value).Path === "string"
          ? [String(object(value).Path)]
          : [],
      )
    : [];

async function named(context: UserContext, name: string | undefined) {
  const library = (
    await listLibraries(context.db, context.caller.user.id)
  ).find((row) => row.name === name);
  if (library === undefined) throw new AuthError("NOT_FOUND");
  return library;
}

async function optionsOf(
  context: UserContext,
  library: Awaited<ReturnType<typeof getLibrary>>,
) {
  return {
    ...object(
      defaultValue(
        openapi.components.schemas.LibraryOptions ?? {},
      ) as JsonValue,
    ),
    ...object(
      await readLibraryPreference(
        context.db,
        context.caller.user.id,
        library.id,
      ),
    ),
    Enabled: true,
    PathInfos: library.roots.map((root) => ({ Path: root.path })),
  };
}

/** Translates only metadata fields that have core storage; schema validation precedes this mapping. */
export function metadataEdit(dto: JsonObject): ItemMetadataEdit {
  const text = (name: string) =>
    typeof dto[name] === "string" ? dto[name] : undefined;
  const nullableText = (name: string) =>
    dto[name] === null ? null : text(name);
  const integer = (name: string) =>
    typeof dto[name] === "number" ? dto[name] : undefined;
  const strings = (name: string) =>
    Array.isArray(dto[name])
      ? dto[name].filter((value) => typeof value === "string")
      : undefined;
  const date = (name: string) => {
    const value = nullableText(name);
    return typeof value === "string" ? value.slice(0, 10) : value;
  };
  const title = text("Name");
  if (title !== undefined && !title.trim())
    throw new AuthError("INVALID_INPUT");
  for (const field of ["IndexNumber", "IndexNumberEnd"])
    if (typeof dto[field] === "number" && dto[field] < 0)
      throw new AuthError("INVALID_INPUT");
  const ids =
    dto.ProviderIds === undefined || dto.ProviderIds === null
      ? undefined
      : Object.fromEntries(
          Object.entries(object(dto.ProviderIds)).flatMap(([key, value]) =>
            typeof value === "string" && value.trim()
              ? [[key.toLowerCase(), value.trim()]]
              : [],
          ),
        );
  const people = Array.isArray(dto.People)
    ? dto.People.map((value, order) => {
        const person = object(value);
        if (typeof person.Name !== "string" || !person.Name.trim())
          throw new AuthError("INVALID_INPUT");
        return {
          name: person.Name.trim(),
          role:
            typeof person.Type === "string"
              ? person.Type.toLowerCase()
              : "actor",
          character: typeof person.Role === "string" ? person.Role : undefined,
          order,
        };
      })
    : undefined;
  return {
    title,
    overview: nullableText("Overview"),
    year: dto.ProductionYear === null ? null : integer("ProductionYear"),
    contentRating: nullableText("OfficialRating"),
    genres: strings("Genres"),
    tags: strings("Tags"),
    providerIds: ids,
    credits: people,
    releaseDate: date("PremiereDate"),
    lastAirDate: date("EndDate"),
    status: text("Status")?.toLowerCase(),
    indexNumber: integer("IndexNumber"),
    indexEndNumber:
      dto.IndexNumberEnd === null ? null : integer("IndexNumberEnd"),
  };
}

const innerRoutes: Extract<Route, { anonymous?: false }>[] = [
  {
    method: "GET",
    path: "/Library/VirtualFolders",
    handle: async (context) =>
      json(
        await Promise.all(
          (await listLibraries(context.db, context.caller.user.id)).map(
            async (library) => ({
              Name: library.name,
              ItemId: toGuid(library.id),
              Locations: library.roots.map((root) => root.path),
              CollectionType:
                library.medium === "movies" ? "movies" : "tvshows",
              LibraryOptions: await optionsOf(context, library),
              RefreshStatus: "Idle",
            }),
          ),
        ),
      ),
  },
  {
    method: "POST",
    path: "/Library/VirtualFolders",
    handle: async (context) => {
      const collection = context.query.get("collectionType")?.toLowerCase();
      // Other media have no core medium; their accepted configuration writes remain neutral.
      if (collection !== "movies" && collection !== "tvshows")
        return noContent();
      const body =
        context.request.body === null
          ? {}
          : await readDto(context.request, "AddVirtualFolderDto");
      const options = object(body.LibraryOptions);
      const requested = context.query.list("paths");
      const library = await createLibrary(context.db, context.caller.user.id, {
        name: context.query.get("name") ?? "",
        medium: collection === "movies" ? "movies" : "shows",
        roots: requested.length ? requested : pathsOf(options),
      });
      await writeLibraryPreference(
        context.db,
        context.caller.user.id,
        library.id,
        options,
      );
      if (context.query.flag("refreshLibrary") === true)
        await scanLibrary(context.db, context.caller.user.id, library.id);
      return noContent();
    },
  },
  {
    method: "DELETE",
    path: "/Library/VirtualFolders",
    handle: async (context) => {
      const library = await named(context, context.query.get("name"));
      await deleteLibrary(context.db, context.caller.user.id, library.id);
      if (context.query.flag("refreshLibrary") === true)
        await rescanLibraries(context.db, context.caller.user.id);
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Library/VirtualFolders/Name",
    handle: async (context) => {
      const library = await named(context, context.query.get("name"));
      const name = context.query.get("newName") ?? "";
      if (
        (await listLibraries(context.db, context.caller.user.id)).some(
          (row) => row.id !== library.id && row.name === name,
        )
      )
        throw new AuthError("CONFLICT");
      await updateLibrary(context.db, context.caller.user.id, library.id, {
        name,
      });
      if (context.query.flag("refreshLibrary") === true)
        await scanLibrary(context.db, context.caller.user.id, library.id);
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Library/VirtualFolders/LibraryOptions",
    handle: async (context) => {
      const dto = await readDto(context.request, "UpdateLibraryOptionsDto");
      const id = requiredGuid(typeof dto.Id === "string" ? dto.Id : undefined);
      const library = await getLibrary(context.db, context.caller.user.id, id);
      const options = object(dto.LibraryOptions);
      if (options.PathInfos !== undefined) {
        const paths = pathsOf(options);
        await updateLibrary(context.db, context.caller.user.id, id, {
          roots: paths.map((path) => ({
            id: library.roots.find((root) => root.path === path)?.id,
            path,
          })),
        });
      }
      await writeLibraryPreference(
        context.db,
        context.caller.user.id,
        id,
        options,
      );
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Library/VirtualFolders/Paths",
    handle: async (context) => {
      const dto = await readDto(context.request, "MediaPathDto");
      const library = await named(
        context,
        typeof dto.Name === "string" ? dto.Name : undefined,
      );
      const path =
        typeof object(dto.PathInfo).Path === "string"
          ? String(object(dto.PathInfo).Path)
          : typeof dto.Path === "string"
            ? dto.Path
            : "";
      if (!library.roots.some((root) => root.path === path))
        await updateLibrary(context.db, context.caller.user.id, library.id, {
          roots: [...library.roots, { path }],
        });
      if (context.query.flag("refreshLibrary") === true)
        await scanLibrary(context.db, context.caller.user.id, library.id);
      return noContent();
    },
  },
  {
    method: "DELETE",
    path: "/Library/VirtualFolders/Paths",
    handle: async (context) => {
      const library = await named(context, context.query.get("name"));
      await updateLibrary(context.db, context.caller.user.id, library.id, {
        roots: library.roots.filter(
          (root) => root.path !== context.query.get("path"),
        ),
      });
      if (context.query.flag("refreshLibrary") === true)
        await scanLibrary(context.db, context.caller.user.id, library.id);
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Library/VirtualFolders/Paths/Update",
    handle: async (context) => {
      const dto = await readDto(context.request, "UpdateMediaPathRequestDto");
      const library = await named(
        context,
        typeof dto.Name === "string" ? dto.Name : undefined,
      );
      // 12.2 MediaPathInfo contains only Path, so there is no secondary field to edit on an existing root.
      if (
        !library.roots.some((root) => root.path === object(dto.PathInfo).Path)
      )
        throw new AuthError("NOT_FOUND");
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/Library/PhysicalPaths",
    handle: async ({ db, caller }) =>
      json(
        (await listLibraries(db, caller.user.id)).flatMap((library) =>
          library.roots.map((root) => root.path),
        ),
      ),
  },
  {
    method: "POST",
    path: "/Library/Refresh",
    handle: async ({ db, caller }) => {
      await rescanLibraries(db, caller.user.id);
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Library/Media/Updated",
    handle: async (context) => {
      const dto = await readDto(context.request, "MediaUpdateInfoDto");
      const paths = Array.isArray(dto.Updates)
        ? dto.Updates.flatMap((update) =>
            typeof object(update).Path === "string"
              ? [String(object(update).Path)]
              : [],
          )
        : [];
      if (paths.some((path) => !isAbsolute(path) || path.includes("\0")))
        throw new AuthError("INVALID_INPUT");
      await rescanLibraries(context.db, context.caller.user.id, { paths });
      return noContent();
    },
  },
  ...(["Movies", "Series"] as const).flatMap((medium) =>
    (["Added", "Updated"] as const).map(
      (event): Extract<Route, { anonymous?: false }> => ({
        method: "POST",
        path: `/Library/${medium}/${event}`,
        handle: async ({ db, caller, query }) => {
          const ids = Object.fromEntries(
            ["tmdb", "imdb", "tvdb"].flatMap((provider) =>
              query.get(`${provider}Id`) === undefined
                ? []
                : [[provider, query.get(`${provider}Id`) ?? ""]],
            ),
          );
          await rescanLibraries(db, caller.user.id, {
            medium: medium === "Movies" ? "movies" : "shows",
            providerIds: ids,
          });
          return noContent();
        },
      }),
    ),
  ),
  {
    method: "POST",
    path: "/Items/{itemId}/Refresh",
    handle: async ({ db, caller, params }) => {
      await refreshItem(db, caller.user.id, requiredGuid(params.itemId));
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Items/{itemId}",
    handle: async (context) => {
      const id = requiredGuid(context.params.itemId);
      const dto = await readDto(context.request, "BaseItemDto");
      const library = (
        await listLibraries(context.db, context.caller.user.id)
      ).find((library) => library.id === id);
      if (library !== undefined)
        await updateLibrary(context.db, context.caller.user.id, id, {
          name: typeof dto.Name === "string" ? dto.Name : undefined,
        });
      else {
        const edit = metadataEdit(dto);
        if (
          (
            await listItemViews(context.db, context.caller.user.id, {
              ids: [id],
            })
          ).items.length
        )
          await editItemMetadata(context.db, context.caller.user.id, id, edit);
        else
          await editContributorMetadata(
            context.db,
            context.caller.user.id,
            id,
            {
              name: edit.title,
              overview: edit.overview,
              providerIds: edit.providerIds,
            },
          );
      }
      return noContent();
    },
  },
  {
    method: "DELETE",
    path: "/Items/{itemId}",
    handle: async ({ db, caller, params }) => {
      await removeCatalogueItems(db, caller.user.id, [
        requiredGuid(params.itemId),
      ]);
      return noContent();
    },
  },
  {
    method: "DELETE",
    path: "/Items",
    handle: async ({ db, caller, query }) => {
      await removeCatalogueItems(
        db,
        caller.user.id,
        query.list("ids").map(requiredGuid),
      );
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/Items/{itemId}/ContentType",
    handle: ({ params }) => {
      requiredGuid(params.itemId);
      // Medium and kind are core identities; Jellyfin's legacy content-type override has no separate model.
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/Items/{itemId}/MetadataEditor",
    handle: async ({ db, caller, params }) => {
      const id = requiredGuid(params.itemId);
      const library = (await listLibraries(db, caller.user.id)).find(
        (row) => row.id === id,
      );
      const [item] = (
        await listItemViews(db, caller.user.id, {
          ids: [id],
        })
      ).items;
      const person =
        item === undefined && library === undefined
          ? await readContributorMetadata(db, caller.user.id, id)
          : undefined;
      return json({
        ParentalRatingOptions: [],
        Countries: [],
        Cultures: [],
        ExternalIdInfos: Object.keys(
          providerIdsDto(item?.providerIds ?? person?.providerIds ?? {}),
        ).map((Key) => ({
          Name: Key,
          Key,
        })),
        ContentType:
          library?.medium === "movies" || item?.kind === "movie"
            ? "movies"
            : library !== undefined || item !== undefined
              ? "tvshows"
              : null,
        ContentTypeOptions: [],
      });
    },
  },
];

/** Library administration and manual metadata writes through generic core services. */
export const libraryRoutes: Route[] = innerRoutes.map((route) => ({
  ...route,
  handle: async (context: UserContext) => {
    try {
      return await route.handle(context);
    } catch (error) {
      if (error instanceof RootError) throw new AuthError("INVALID_INPUT");
      throw error;
    }
  },
}));
