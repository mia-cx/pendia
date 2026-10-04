import type { MetadataProvider, MetadataResult } from "@pendia/plugin-api";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  contributors,
  credits,
  episodes,
  items,
  libraries,
  providerIds,
  seasons,
  shows,
} from "../db/schema/index.ts";
import { providersForLibrary, readMetadataSettings } from "./settings.ts";

const contributorsLockKey = 0x70656e646374n;

export type MetadataApplication =
  | {
      state: "matched";
      provider: string;
      providerId: string;
      confidence: number;
      artwork: MetadataResult["artwork"];
    }
  | { state: "unmatched"; artwork: [] }
  // No enabled provider handles the Item, so it stays pending for a later fetch.
  | { state: "pending"; artwork: [] };

type MetadataMatch = Awaited<ReturnType<MetadataProvider["search"]>>[number];

function bestMatch(
  matches: MetadataMatch[],
  threshold: number,
): MetadataMatch | undefined {
  let best: MetadataMatch | undefined;
  let tied = false;
  for (const match of matches) {
    if (best === undefined || match.confidence > best.confidence) {
      best = match;
      tied = false;
    } else if (match.confidence === best.confidence) {
      tied = true;
    }
  }
  if (best === undefined || tied || best.confidence < threshold)
    return undefined;
  return best;
}

async function persistMatch(
  db: Database,
  itemId: string,
  libraryId: string,
  provider: string,
  providerId: string,
  confidence: number,
  result: MetadataResult,
  expectedIds: readonly OwnedProviderId[],
  searched: boolean,
): Promise<MetadataApplication> {
  const idEntries = new Map<string, string>();
  for (const [name, value] of Object.entries(result.providerIds)) {
    const trimmedName = name.trim();
    const trimmedValue = typeof value === "string" ? value.trim() : "";
    if (trimmedName.length === 0 || trimmedValue.length === 0)
      throw new Error("Invalid provider metadata.");
    idEntries.set(trimmedName, trimmedValue);
  }
  return db.transaction(async (tx) => {
    const [lockedLibrary] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!lockedLibrary) throw new AuthError("NOT_FOUND");
    const [locked] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .for("update");
    if (!locked || locked.libraryId !== lockedLibrary.id)
      throw new AuthError("NOT_FOUND");
    await assertProviderIdsUnchanged(tx, itemId, expectedIds);
    if (searched) {
      // Search matches may not collide with another Item's provider id.
      for (const [name, value] of idEntries) {
        const [collision] = await tx
          .select({ itemId: providerIds.itemId })
          .from(providerIds)
          .innerJoin(items, eq(items.id, providerIds.itemId))
          .where(
            and(
              eq(items.libraryId, libraryId),
              eq(providerIds.provider, name),
              eq(providerIds.value, value),
              ne(providerIds.itemId, itemId),
            ),
          )
          .limit(1);
        if (collision !== undefined) {
          await tx
            .update(items)
            .set({ metadataState: "unmatched", updatedAt: new Date() })
            .where(eq(items.id, itemId));
          return { state: "unmatched", artwork: [] };
        }
      }
    }
    await tx
      .update(items)
      .set({
        title: result.title,
        overview: result.overview,
        year: result.year,
        contentRating: result.contentRating,
        genres: result.genres,
        metadataState: "matched",
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId));
    await persistKindFields(tx, locked.kind, itemId, result);
    // Result ids replace only provider-derived rows; explicit scan-owned ids
    // keep their value and provenance.
    const returnedProviders = [...idEntries.keys()];
    await tx
      .delete(providerIds)
      .where(
        and(
          eq(providerIds.itemId, itemId),
          eq(providerIds.metadataDerived, true),
          returnedProviders.length > 0
            ? notInArray(providerIds.provider, returnedProviders)
            : undefined,
        ),
      );
    for (const [provider, value] of idEntries) {
      const [existing] = await tx
        .select()
        .from(providerIds)
        .where(
          and(
            eq(providerIds.itemId, itemId),
            eq(providerIds.provider, provider),
          ),
        );
      if (existing) {
        if (!existing.metadataDerived) continue;
        if (existing.value !== value)
          await tx
            .update(providerIds)
            .set({ value })
            .where(eq(providerIds.id, existing.id));
      } else {
        await tx
          .insert(providerIds)
          .values({ itemId, provider, value, metadataDerived: true });
      }
    }
    await tx.delete(credits).where(eq(credits.itemId, itemId));
    const contributorIds = new Map<string, string>();
    const names = [
      ...new Set(result.credits.map((credit) => credit.name)),
    ].sort();
    // One lock serializes Contributor creation. A lock per name would let a
    // response with many credits exhaust Postgres's shared lock table.
    if (names.length > 0)
      await tx.execute(
        sql`select pg_advisory_xact_lock(${contributorsLockKey})`,
      );
    if (names.length > 0) {
      const existing = await tx
        .select()
        .from(contributors)
        .where(inArray(contributors.name, names))
        .orderBy(contributors.id);
      for (const contributor of existing)
        if (!contributorIds.has(contributor.name))
          contributorIds.set(contributor.name, contributor.id);
      const missing = names.filter((name) => !contributorIds.has(name));
      if (missing.length > 0) {
        const created = await tx
          .insert(contributors)
          .values(missing.map((name) => ({ name })))
          .returning();
        for (const contributor of created)
          contributorIds.set(contributor.name, contributor.id);
      }
    }
    if (result.credits.length > 0)
      await tx.insert(credits).values(
        result.credits.map((credit) => {
          const contributorId = contributorIds.get(credit.name);
          if (contributorId === undefined)
            throw new Error("Invalid provider metadata.");
          return {
            itemId,
            contributorId,
            role: credit.role,
            character: credit.character ?? null,
            order: credit.order,
          };
        }),
      );
    const application: MetadataApplication = {
      state: "matched",
      provider,
      providerId,
      confidence,
      artwork: [...result.artwork],
    };
    return application;
  });
}

/** Writes the dates and status a result carries into the Item's kind table; absent fields stay. */
async function persistKindFields(
  tx: Connection,
  kind: string,
  itemId: string,
  { releaseDate, lastAirDate, status }: MetadataResult,
): Promise<void> {
  if (kind === "show") {
    const fields = { firstAirDate: releaseDate, lastAirDate, status };
    if (Object.values(fields).every((value) => value === undefined)) return;
    await tx.update(shows).set(fields).where(eq(shows.itemId, itemId));
    return;
  }
  if (releaseDate === undefined) return;
  if (kind === "season")
    await tx
      .update(seasons)
      .set({ airDate: releaseDate })
      .where(eq(seasons.itemId, itemId));
  if (kind === "episode")
    await tx
      .update(episodes)
      .set({ airDate: releaseDate })
      .where(eq(episodes.itemId, itemId));
}

type SearchQuery = Parameters<MetadataProvider["search"]>[0];

/** The parent Show's provider ids and the Item's numbers, which Season and Episode searches need. */
async function showContext(
  db: Database,
  item: { id: string; kind: string },
): Promise<SearchQuery["show"]> {
  const showIds = async (showId: string) =>
    Object.fromEntries(
      (await itemProviderIdSnapshot(db, showId)).map((row) => [
        row.provider,
        row.value,
      ]),
    );
  if (item.kind === "season") {
    const [season] = await db
      .select()
      .from(seasons)
      .where(eq(seasons.itemId, item.id));
    if (!season) return undefined;
    return {
      providerIds: await showIds(season.showId),
      seasonNumber: season.seasonNumber,
    };
  }
  if (item.kind !== "episode") return undefined;
  const [episode] = await db
    .select({
      showId: seasons.showId,
      seasonNumber: seasons.seasonNumber,
      episodeNumber: episodes.episodeNumber,
    })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.itemId, episodes.seasonId))
    .where(eq(episodes.itemId, item.id));
  if (!episode) return undefined;
  return {
    providerIds: await showIds(episode.showId),
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
  };
}

type OwnedProviderId = {
  provider: string;
  value: string;
  metadataDerived: boolean;
};

type Connection =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Reads the Item's provider ids in a deterministic order for comparisons. */
async function itemProviderIdSnapshot(
  db: Connection,
  itemId: string,
): Promise<OwnedProviderId[]> {
  const rows = await db
    .select({
      provider: providerIds.provider,
      value: providerIds.value,
      metadataDerived: providerIds.metadataDerived,
    })
    .from(providerIds)
    .where(eq(providerIds.itemId, itemId));
  rows.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) || a.value.localeCompare(b.value),
  );
  return rows;
}

/** Rejects a stale fetch when any provider id changed after the job read its snapshot. */
async function assertProviderIdsUnchanged(
  tx: Connection,
  itemId: string,
  expected: readonly OwnedProviderId[],
): Promise<void> {
  const current = await itemProviderIdSnapshot(tx, itemId);
  const unchanged =
    current.length === expected.length &&
    current.every((row, index) => {
      const snapshot = expected[index];
      return (
        snapshot !== undefined &&
        row.provider === snapshot.provider &&
        row.value === snapshot.value &&
        row.metadataDerived === snapshot.metadataDerived
      );
    });
  if (!unchanged)
    throw new Error("Provider ids changed during metadata fetch.");
}

async function persistUnmatched(
  db: Database,
  itemId: string,
  libraryId: string,
  expectedIds: readonly OwnedProviderId[],
): Promise<MetadataApplication> {
  return db.transaction(async (tx) => {
    const [lockedLibrary] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!lockedLibrary) throw new AuthError("NOT_FOUND");
    const [locked] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .for("update");
    if (!locked || locked.libraryId !== lockedLibrary.id)
      throw new AuthError("NOT_FOUND");
    await assertProviderIdsUnchanged(tx, itemId, expectedIds);
    await tx
      .update(items)
      .set({ metadataState: "unmatched", updatedAt: new Date() })
      .where(eq(items.id, itemId));
    return { state: "unmatched", artwork: [] };
  });
}

/** Matches one Item and applies provider metadata transactionally. */
export async function applyMetadata(
  db: Database,
  itemId: string,
  providers: readonly MetadataProvider[],
): Promise<MetadataApplication> {
  const [item] = await db
    .select()
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!item) throw new AuthError("NOT_FOUND");
  const config = await readMetadataSettings(db);
  const idSnapshot = await itemProviderIdSnapshot(db, item.id);
  const snapshotByProvider = new Map(
    idSnapshot.map((row) => [row.provider, row.value]),
  );
  const show = await showContext(db, item);
  let consulted = false;
  for (const providerId of providersForLibrary(config, item.libraryId)) {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider === undefined || !provider.kinds.includes(item.kind)) continue;
    consulted = true;
    const existingValue = snapshotByProvider.get(provider.id);
    if (existingValue !== undefined) {
      const result = await provider.fetch({
        providerId: existingValue,
        kind: item.kind,
      });
      // The provider no longer knows the stored id: an admin has to fix it.
      if (result === null)
        return persistUnmatched(db, item.id, item.libraryId, idSnapshot);
      return persistMatch(
        db,
        item.id,
        item.libraryId,
        provider.id,
        existingValue,
        1,
        result,
        idSnapshot,
        false,
      );
    }
    const matches = await provider.search({
      title: item.title,
      year: item.year ?? undefined,
      kind: item.kind,
      providerIds: Object.fromEntries(snapshotByProvider),
      show,
    });
    const best = bestMatch(matches, config.confidenceThreshold);
    if (best === undefined) continue;
    const result = await provider.fetch({
      providerId: best.providerId,
      kind: item.kind,
    });
    // The match vanished between search and fetch; try the next provider.
    if (result === null) continue;
    return persistMatch(
      db,
      item.id,
      item.libraryId,
      provider.id,
      best.providerId,
      best.confidence,
      result,
      idSnapshot,
      true,
    );
  }
  // Unmatched means a provider looked and found no confident match. Without
  // one, the Item stays pending so a later key or settings change can fetch it.
  if (!consulted) return { state: "pending", artwork: [] };
  return persistUnmatched(db, item.id, item.libraryId, idSnapshot);
}
