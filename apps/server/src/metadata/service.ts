import type { MetadataProvider, MetadataResult } from "@pendia/plugin-api";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  contributors,
  credits,
  items,
  providerIds,
} from "../db/schema/index.ts";
import { providersForLibrary, readMetadataSettings } from "./settings.ts";

export type MetadataApplication =
  | {
      state: "matched";
      provider: string;
      providerId: string;
      confidence: number;
      artwork: MetadataResult["artwork"];
    }
  | { state: "unmatched"; artwork: [] };

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
  provider: string,
  providerId: string,
  confidence: number,
  result: MetadataResult,
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
    const [locked] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
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
        if (existing.value !== value)
          await tx
            .update(providerIds)
            .set({ value })
            .where(eq(providerIds.id, existing.id));
      } else {
        await tx.insert(providerIds).values({ itemId, provider, value });
      }
    }
    await tx.delete(credits).where(eq(credits.itemId, itemId));
    const contributorIds = new Map<string, string>();
    const names = [
      ...new Set(result.credits.map((credit) => credit.name)),
    ].sort();
    for (const name of names)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`,
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

async function persistUnmatched(
  db: Database,
  itemId: string,
): Promise<MetadataApplication> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
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
  for (const providerId of providersForLibrary(config, item.libraryId)) {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider === undefined || !provider.kinds.includes(item.kind)) continue;
    const [existing] = await db
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.itemId, item.id),
          eq(providerIds.provider, provider.id),
        ),
      )
      .limit(1);
    if (existing) {
      const result = await provider.fetch({
        providerId: existing.value,
        kind: item.kind,
      });
      return persistMatch(db, item.id, provider.id, existing.value, 1, result);
    }
    const matches = await provider.search({
      title: item.title,
      year: item.year ?? undefined,
      kind: item.kind,
    });
    const best = bestMatch(matches, config.confidenceThreshold);
    if (best === undefined) continue;
    const result = await provider.fetch({
      providerId: best.providerId,
      kind: item.kind,
    });
    return persistMatch(
      db,
      item.id,
      provider.id,
      best.providerId,
      best.confidence,
      result,
    );
  }
  return persistUnmatched(db, item.id);
}
