import type {
  ItemKind,
  MetadataProvider,
  MetadataResult,
} from "@thalia/plugin-api";
import { eq } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { items, providerIds } from "../db/schema/index.ts";
import { selectedArtworkId, storeArtworkOriginal } from "./artwork-store.ts";
import { editItemMetadata } from "./edit.ts";
import { queueProviderFetch } from "./jobs.ts";
import {
  type MetadataProviderOptions,
  metadataProviders,
} from "./providers.ts";
import { providersForLibrary, readMetadataSettings } from "./settings.ts";

async function subject(db: Database, actorId: string, id: string) {
  const [item] = await db.select().from(items).where(eq(items.id, id));
  if (item === undefined) return null;
  await requirePermission(db, actorId, "view", item.libraryId);
  const ids = await db
    .select({ provider: providerIds.provider, value: providerIds.value })
    .from(providerIds)
    .where(eq(providerIds.itemId, id));
  return {
    ...item,
    providerIds: Object.fromEntries(
      ids.map((row) => [row.provider, row.value]),
    ),
  };
}

async function providersFor(
  db: Database,
  kind: ItemKind,
  libraryId: string | undefined,
  options: MetadataProviderOptions,
  includeDisabled = false,
) {
  const available = await metadataProviders(db, options);
  const config = await readMetadataSettings(db);
  const enabled =
    libraryId === undefined
      ? config.providerOrder
      : providersForLibrary(config, libraryId);
  return (
    includeDisabled
      ? available
      : enabled.flatMap((id) =>
          available.filter((provider) => provider.id === id),
        )
  ).filter((provider) => provider.kinds.includes(kind));
}

/** Searches enabled providers, preserving their result order and the provider owning each match. */
export async function searchRemoteMetadata(
  db: Database,
  actorId: string,
  input: Parameters<MetadataProvider["search"]>[0] & {
    itemId?: string;
    providerName?: string;
    includeDisabled?: boolean;
  },
  options: MetadataProviderOptions = {},
) {
  const item =
    input.itemId === undefined
      ? null
      : await subject(db, actorId, input.itemId);
  const providers = await providersFor(
    db,
    input.kind,
    item?.libraryId,
    options,
    input.includeDisabled,
  );
  const results = [];
  for (const provider of providers) {
    if (
      input.providerName !== undefined &&
      provider.id.toLowerCase() !== input.providerName.toLowerCase()
    )
      continue;
    const explicitId = input.providerIds?.[provider.id];
    if (explicitId !== undefined) {
      const known = await provider.fetch({
        providerId: explicitId,
        kind: input.kind,
      });
      if (known !== null)
        results.push({
          providerId: explicitId,
          title: known.title,
          year: known.year,
          confidence: 1,
          provider: provider.id,
        });
      continue;
    }
    const matches = await provider.search(input);
    results.push(
      ...matches.map((match) => ({ ...match, provider: provider.id })),
    );
  }
  return results;
}

/** Lists providers able to fetch this viewable item's metadata and artwork. */
export async function remoteMetadataProviders(
  db: Database,
  actorId: string,
  itemId: string,
  options: MetadataProviderOptions = {},
) {
  const item = await subject(db, actorId, itemId);
  if (item === null) return [];
  return (await providersFor(db, item.kind, item.libraryId, options)).map(
    (provider) => ({ id: provider.id, kinds: provider.kinds }),
  );
}

/** Lists remote artwork for the item's stored external identities without changing selected images. */
export async function remoteArtwork(
  db: Database,
  actorId: string,
  itemId: string,
  providerName: string | undefined,
  options: MetadataProviderOptions = {},
) {
  const item = await subject(db, actorId, itemId);
  if (item === null) return { images: [], providers: [] };
  const providers = await providersFor(db, item.kind, item.libraryId, options);
  const images = [];
  for (const provider of providers) {
    if (
      providerName !== undefined &&
      provider.id.toLowerCase() !== providerName.toLowerCase()
    )
      continue;
    const id = item.providerIds[provider.id];
    if (id === undefined) continue;
    const result = await provider.fetch({ providerId: id, kind: item.kind });
    if (result !== null)
      images.push(
        ...result.artwork.map((image) => ({ ...image, provider: provider.id })),
      );
  }
  return { images, providers: providers.map((provider) => provider.id) };
}

/** Selects identifiers and applies their provider metadata; absent credentials leave a fetch queued for later. */
export async function selectRemoteMetadata(
  db: Database,
  actorId: string,
  itemId: string,
  input: {
    providerIds: Record<string, string>;
    providerName?: string;
    replaceArtwork: boolean;
  },
  options: MetadataProviderOptions = {},
) {
  const item = await subject(db, actorId, itemId);
  if (item === null) throw new AuthError("NOT_FOUND");
  await requirePermission(db, actorId, "manage-metadata", item.libraryId);
  if (Object.keys(input.providerIds).length === 0)
    throw new AuthError("INVALID_INPUT");
  const providers = await providersFor(
    db,
    item.kind,
    item.libraryId,
    options,
    true,
  );
  const provider = providers.find(
    (provider) =>
      (input.providerName === undefined ||
        provider.id.toLowerCase() === input.providerName.toLowerCase()) &&
      input.providerIds[provider.id] !== undefined,
  );
  if (provider === undefined) {
    await editItemMetadata(db, actorId, itemId, {
      providerIds: input.providerIds,
      metadataState: "pending",
    });
    await queueProviderFetch(db, itemId, 1);
    return;
  }
  const id = input.providerIds[provider.id];
  if (id === undefined) throw new AuthError("INVALID_INPUT");
  const result = await provider.fetch({ providerId: id, kind: item.kind });
  if (result === null) throw new AuthError("NOT_FOUND");
  await editItemMetadata(db, actorId, itemId, {
    title: result.title,
    overview: result.overview,
    year: result.year,
    contentRating: result.contentRating,
    genres: result.genres,
    credits: result.credits,
    releaseDate: result.releaseDate,
    lastAirDate: result.lastAirDate,
    status: result.status,
    providerIds: { ...result.providerIds, ...input.providerIds },
    metadataState: "matched",
  });
  const selected = new Set<string>();
  for (const image of result.artwork) {
    if (selected.has(image.type)) continue;
    selected.add(image.type);
    if (
      !input.replaceArtwork &&
      (await selectedArtworkId(db, itemId, image.type)) !== undefined
    )
      continue;
    await storeArtworkOriginal(db, itemId, image, options.request);
  }
  await publishEvent(db, {
    kind: "library.changed",
    libraryId: item.libraryId,
  });
}

/** Selects one downloaded artwork original for an item after checking metadata-management permission. */
export async function downloadRemoteArtwork(
  db: Database,
  actorId: string,
  itemId: string,
  image: MetadataResult["artwork"][number],
  request: typeof fetch = fetch,
) {
  const item = await subject(db, actorId, itemId);
  await requirePermission(db, actorId, "manage-metadata", item?.libraryId);
  // Libraries and metadata identities have no artwork owner in the core.
  if (item === null) return;
  await storeArtworkOriginal(db, itemId, image, request);
  await publishEvent(db, {
    kind: "library.changed",
    libraryId: item.libraryId,
  });
}
