import type { MetadataResult } from "@thalia/plugin-api";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  contributors,
  credits,
  episodes,
  items,
  libraries,
  movies,
  providerIds,
  seasons,
  shows,
} from "../db/schema/index.ts";
import { type DeletedArtworkFile, deleteItemSubtree } from "../db/tree.ts";
import { setItemProviderIds } from "../libraries/changes.ts";
import { emitPluginEvents } from "../plugins/events.ts";
import { removeArtworkFiles } from "./artwork-store.ts";
import { replaceItemCredits } from "./service.ts";

/** Core metadata fields an editor may change, independent of any client protocol. */
export type ItemMetadataEdit = Partial<
  Pick<
    typeof items.$inferInsert,
    | "title"
    | "year"
    | "overview"
    | "contentRating"
    | "genres"
    | "tags"
    | "metadataState"
  >
> & {
  providerIds?: Record<string, string>;
  credits?: MetadataResult["credits"];
  releaseDate?: string | null;
  lastAirDate?: string | null;
  status?: string | null;
  indexNumber?: number;
  indexEndNumber?: number | null;
};

/** Applies a manual edit under the library/item locks used by provider fetches, then publishes the change. */
export async function editItemMetadata(
  db: Database,
  actorId: string,
  id: string,
  input: ItemMetadataEdit,
) {
  const [subject] = await db
    .select({ libraryId: items.libraryId })
    .from(items)
    .where(eq(items.id, id));
  if (subject === undefined) throw new AuthError("NOT_FOUND");
  await requirePermission(db, actorId, "manage-metadata", subject.libraryId);
  await db.transaction(async (tx) => {
    const [library] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, subject.libraryId))
      .for("update");
    if (library === undefined) throw new AuthError("NOT_FOUND");
    const [item] = await tx
      .select()
      .from(items)
      .where(eq(items.id, id))
      .for("update");
    if (item === undefined) throw new AuthError("NOT_FOUND");
    const {
      providerIds: ids,
      credits,
      releaseDate,
      lastAirDate,
      status,
      indexNumber,
      indexEndNumber,
      ...fields
    } = input;
    await tx
      .update(items)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(items.id, id));
    if (ids !== undefined) {
      const names = Object.keys(ids);
      await tx
        .delete(providerIds)
        .where(
          and(
            eq(providerIds.itemId, id),
            names.length ? notInArray(providerIds.provider, names) : undefined,
          ),
        );
      await setItemProviderIds(tx, id, ids);
    }
    if (credits !== undefined) await replaceItemCredits(tx, id, credits);
    if (item.kind === "movie" && releaseDate !== undefined)
      await tx.update(movies).set({ releaseDate }).where(eq(movies.itemId, id));
    if (
      item.kind === "show" &&
      [releaseDate, lastAirDate, status].some((value) => value !== undefined)
    )
      await tx
        .update(shows)
        .set({ firstAirDate: releaseDate, lastAirDate, status })
        .where(eq(shows.itemId, id));
    if (
      item.kind === "season" &&
      [releaseDate, indexNumber].some((value) => value !== undefined)
    )
      await tx
        .update(seasons)
        .set({ airDate: releaseDate, seasonNumber: indexNumber })
        .where(eq(seasons.itemId, id));
    if (
      item.kind === "episode" &&
      [releaseDate, indexNumber, indexEndNumber].some(
        (value) => value !== undefined,
      )
    )
      await tx
        .update(episodes)
        .set({
          airDate: releaseDate,
          episodeNumber: indexNumber,
          episodeEndNumber: indexEndNumber,
        })
        .where(eq(episodes.itemId, id));
    await emitPluginEvents(tx, [
      { event: "item.updated", payload: { itemId: id, kind: item.kind } },
    ]);
    await publishEvent(tx, {
      kind: "library.changed",
      libraryId: item.libraryId,
    });
  });
}

/** Reads a contributor and its external identifiers for a caller holding metadata-management permission. */
export async function readContributorMetadata(
  db: Database,
  actorId: string,
  id: string,
) {
  await requirePermission(db, actorId, "manage-metadata");
  const [person] = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, id));
  if (person === undefined) throw new AuthError("NOT_FOUND");
  const ids = await db
    .select({ provider: providerIds.provider, value: providerIds.value })
    .from(providerIds)
    .where(eq(providerIds.contributorId, id));
  return {
    ...person,
    providerIds: Object.fromEntries(
      ids.map((row) => [row.provider, row.value]),
    ),
  };
}

/** Edits contributor identity/metadata and notifies libraries using its credits. */
export async function editContributorMetadata(
  db: Database,
  actorId: string,
  id: string,
  input: {
    name?: string;
    overview?: string | null;
    providerIds?: Record<string, string>;
  },
) {
  await requirePermission(db, actorId, "manage-metadata");
  await db.transaction(async (tx) => {
    const [person] = await tx
      .select({ id: contributors.id })
      .from(contributors)
      .where(eq(contributors.id, id))
      .for("update");
    if (person === undefined) throw new AuthError("NOT_FOUND");
    if (input.name !== undefined || input.overview !== undefined)
      await tx
        .update(contributors)
        .set({ name: input.name, overview: input.overview })
        .where(eq(contributors.id, id));
    if (input.providerIds !== undefined) {
      await tx.delete(providerIds).where(eq(providerIds.contributorId, id));
      const ids = Object.entries(input.providerIds);
      if (ids.length)
        await tx.insert(providerIds).values(
          ids.map(([provider, value]) => ({
            contributorId: id,
            provider,
            value,
            metadataDerived: false,
          })),
        );
    }
    const affected = await tx
      .selectDistinct({ libraryId: items.libraryId })
      .from(items)
      .innerJoin(credits, eq(credits.itemId, items.id))
      .where(eq(credits.contributorId, id));
    for (const library of affected)
      await publishEvent(tx, {
        kind: "library.changed",
        libraryId: library.libraryId,
      });
  });
}

/** Removes catalogue subtrees and stored artwork; source media files remain on disk. */
export async function removeCatalogueItems(
  db: Database,
  actorId: string,
  ids: readonly string[],
) {
  await requirePermission(db, actorId, "manage-libraries");
  if (ids.length === 0) return;
  const removedArtwork: DeletedArtworkFile[] = [];
  await db.transaction(async (tx) => {
    // Library/id order matches scan locking and makes overlapping subtree requests harmless.
    const subjects = await tx
      .select({ id: items.id, libraryId: items.libraryId })
      .from(items)
      .where(inArray(items.id, [...ids]))
      .orderBy(asc(items.libraryId), asc(items.id));
    for (const item of subjects) {
      await tx
        .select({ id: libraries.id })
        .from(libraries)
        .where(eq(libraries.id, item.libraryId))
        .for("update");
      const [current] = await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, item.id));
      if (current === undefined) continue;
      await deleteItemSubtree(tx, item.id, removedArtwork);
      await publishEvent(tx, {
        kind: "library.changed",
        libraryId: item.libraryId,
      });
    }
  });
  await removeArtworkFiles(removedArtwork);
}
