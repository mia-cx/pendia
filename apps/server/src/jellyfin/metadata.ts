import { listContributorCredits, listItemViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import type { JsonValue } from "../db/schema/common.ts";
import {
  downloadRemoteArtwork,
  remoteArtwork,
  remoteMetadataProviders,
  searchRemoteMetadata,
  selectRemoteMetadata,
} from "../metadata/lookup.ts";
import type { MetadataProviderOptions } from "../metadata/providers.ts";
import { json, noContent, type Route } from "./http.ts";
import { providerIdsDto } from "./items.ts";
import { requiredGuid } from "./request.ts";
import { readDto } from "./schema.ts";

const imageTypes = {
  poster: "Primary",
  backdrop: "Backdrop",
  logo: "Logo",
  thumb: "Thumb",
} as const;

function identifierMap(value: JsonValue | undefined) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, value]) =>
      typeof value === "string" && value.trim()
        ? [[key.toLowerCase(), value.trim()]]
        : [],
    ),
  );
}

/** Remote metadata and artwork selection through configured built-in and plugin providers. */
export function metadataLookupRoutes(
  options: MetadataProviderOptions = {},
): Route[] {
  return [
    ...(["Movie", "Series"] as const).map(
      (type): Route => ({
        method: "POST",
        path: `/Items/RemoteSearch/${type}`,
        handle: async ({ db, caller, request }) => {
          const dto = await readDto(
            request,
            `${type === "Movie" ? "Movie" : "Series"}InfoRemoteSearchQuery`,
          );
          const raw = dto.SearchInfo;
          const search =
            raw !== null && typeof raw === "object" && !Array.isArray(raw)
              ? raw
              : {};
          const itemId =
            typeof dto.ItemId === "string"
              ? requiredGuid(dto.ItemId)
              : undefined;
          const results = await searchRemoteMetadata(
            db,
            caller.user.id,
            {
              kind: type === "Movie" ? "movie" : "show",
              title: typeof search.Name === "string" ? search.Name : "",
              year: typeof search.Year === "number" ? search.Year : undefined,
              providerIds: identifierMap(search.ProviderIds),
              itemId:
                itemId === "00000000-0000-0000-0000-000000000000"
                  ? undefined
                  : itemId,
              providerName:
                typeof dto.SearchProviderName === "string" &&
                dto.SearchProviderName
                  ? dto.SearchProviderName
                  : undefined,
              includeDisabled: dto.IncludeDisabledProviders === true,
            },
            options,
          );
          return json(
            results.map((result) => ({
              Name: result.title,
              ProductionYear: result.year,
              ProviderIds: providerIdsDto({
                [result.provider]: result.providerId,
              }),
              SearchProviderName: result.provider,
            })),
          );
        },
      }),
    ),
    {
      method: "GET",
      path: "/Items/{itemId}/ExternalIdInfos",
      handle: async ({ db, caller, params }) => {
        const id = requiredGuid(params.itemId);
        const [item] = (await listItemViews(db, caller.user.id, { ids: [id] }))
          .items;
        const person =
          item === undefined
            ? (await listContributorCredits(db, caller.user.id)).find(
                (person) => person.id === id,
              )
            : undefined;
        return json(
          Object.keys(
            providerIdsDto(item?.providerIds ?? person?.providerIds ?? {}),
          ).map((Key) => ({ Name: Key, Key })),
        );
      },
    },
    {
      method: "POST",
      path: "/Items/RemoteSearch/Apply/{itemId}",
      handle: async ({ db, caller, params, request, query }) => {
        const dto = await readDto(request, "RemoteSearchResult");
        await selectRemoteMetadata(
          db,
          caller.user.id,
          requiredGuid(params.itemId),
          {
            providerIds: identifierMap(dto.ProviderIds),
            providerName:
              typeof dto.SearchProviderName === "string"
                ? dto.SearchProviderName
                : undefined,
            replaceArtwork: query.flag("replaceAllImages") ?? true,
          },
          options,
        );
        return noContent();
      },
    },
    {
      method: "GET",
      path: "/Items/{itemId}/RemoteImages",
      handle: async ({ db, caller, params, query }) => {
        const remote = await remoteArtwork(
          db,
          caller.user.id,
          requiredGuid(params.itemId),
          query.get("providerName"),
          options,
        );
        const type = query.get("type")?.toLowerCase();
        const images = remote.images.filter(
          (image) =>
            type === undefined || imageTypes[image.type].toLowerCase() === type,
        );
        const start = query.count("startIndex") ?? 0;
        const limit = query.count("limit");
        return json({
          Images: images
            .slice(start, limit === undefined ? undefined : start + limit)
            .map((image) => ({
              Url: image.url,
              ThumbnailUrl: image.url,
              ProviderName: image.provider,
              Type: imageTypes[image.type],
              RatingType: "Score",
            })),
          TotalRecordCount: images.length,
          Providers: remote.providers,
        });
      },
    },
    {
      method: "GET",
      path: "/Items/{itemId}/RemoteImages/Providers",
      handle: async ({ db, caller, params }) =>
        json(
          (
            await remoteMetadataProviders(
              db,
              caller.user.id,
              requiredGuid(params.itemId),
              options,
            )
          ).map((provider) => ({
            Name: provider.id,
            SupportedImages: Object.values(imageTypes),
          })),
        ),
    },
    {
      method: "POST",
      path: "/Items/{itemId}/RemoteImages/Download",
      handle: async ({ db, caller, params, query }) => {
        const type = (["poster", "backdrop", "logo", "thumb"] as const).find(
          (type) =>
            imageTypes[type].toLowerCase() === query.get("type")?.toLowerCase(),
        );
        if (type === undefined) return noContent();
        const value = query.get("imageUrl");
        let url: URL;
        try {
          url = new URL(value ?? "");
        } catch {
          throw new AuthError("INVALID_INPUT");
        }
        if (!["http:", "https:"].includes(url.protocol))
          throw new AuthError("INVALID_INPUT");
        await downloadRemoteArtwork(
          db,
          caller.user.id,
          requiredGuid(params.itemId),
          { type, url: url.href },
          options.request,
        );
        return noContent();
      },
    },
  ];
}
