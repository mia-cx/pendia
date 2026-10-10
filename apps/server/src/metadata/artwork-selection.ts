import type { MetadataResult } from "@thalia/plugin-api";
import type { Database } from "../db/client.ts";
import {
  removeSelectedArtwork,
  selectedArtworkId,
  storeArtworkOriginal,
} from "./artwork-store.ts";

/** Core artwork kinds that may hold a selected original. */
export const selectableArtworkTypes = [
  "poster",
  "backdrop",
  "logo",
  "thumb",
] as const;

/** Applies a provider's first candidate per kind and removes obsolete selections when replacement is enabled. */
export async function applyArtworkSelection(
  db: Database,
  itemId: string,
  candidates: MetadataResult["artwork"],
  request: typeof fetch = fetch,
  {
    preserveExisting = false,
    types = selectableArtworkTypes,
  }: {
    preserveExisting?: boolean;
    types?: readonly MetadataResult["artwork"][number]["type"][];
  } = {},
) {
  for (const type of types) {
    if (
      preserveExisting &&
      (await selectedArtworkId(db, itemId, type)) !== undefined
    )
      continue;
    const candidate = candidates.find((candidate) => candidate.type === type);
    if (candidate === undefined) {
      await removeSelectedArtwork(db, itemId, type);
      continue;
    }
    await storeArtworkOriginal(db, itemId, candidate, request);
  }
}
