import { and, desc, inArray } from "drizzle-orm";
import { viewableLibraryIds } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { itemKind, items } from "../db/schema/index.ts";
import type { CoreShelf, Medium } from "../mediums/medium.ts";
import { moviesMedium } from "../mediums/movies.ts";
import { createShowsMedium } from "../mediums/shows.ts";
import { continueWatching } from "../playback/marks.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import { browseCards, browseCardsById } from "./items.ts";

/** The most entries one Home shelf holds. */
export const shelfSize = 24;

type Card = Awaited<ReturnType<typeof browseCards>>[number];
type Entry = {
  item: Card;
  progress: { positionSeconds: number; durationSeconds: number | null } | null;
};
type ItemKind = (typeof itemKind.enumValues)[number];

const isItemKind = (kind: string): kind is ItemKind =>
  itemKind.enumValues.some((known) => known === kind);

const kindsOf = (mediums: Medium[], roots: boolean) =>
  mediums.flatMap((medium) =>
    medium.kinds
      .filter((kind) => !roots || kind.parent === null)
      .map((kind) => kind.kind)
      .filter(isItemKind),
  );

const bare = (item: Card): Entry => ({ item, progress: null });

async function continueEntries(
  db: Database,
  userId: string,
  mediums: Medium[],
): Promise<Entry[]> {
  const kinds = new Set<string>(kindsOf(mediums, false));
  const page = await continueWatching(db, userId, { limit: shelfSize });
  const rows = page.items.filter((row) => kinds.has(row.item.kind));
  const cards = new Map(
    (
      await browseCardsById(
        db,
        rows.map((row) => row.item.id),
      )
    ).map((card) => [card.id, card]),
  );
  return rows.flatMap((row) => {
    const item = cards.get(row.item.id);
    if (item === undefined) return [];
    const { positionSeconds } = row.progress;
    return [
      {
        item,
        progress: { positionSeconds, durationSeconds: row.durationSeconds },
      },
    ];
  });
}

async function recentlyAdded(
  db: Database,
  userId: string,
  mediums: Medium[],
): Promise<Entry[]> {
  const viewable = await viewableLibraryIds(db, userId);
  const roots = kindsOf(mediums, true);
  if (viewable.length === 0 || roots.length === 0) return [];
  const cards = await browseCards(
    db,
    and(inArray(items.libraryId, viewable), inArray(items.kind, roots)),
    [desc(items.addedAt), desc(items.id)],
    shelfSize,
  );
  return cards.map(bare);
}

type ShelfLoader = (
  db: Database,
  userId: string,
  mediums: Medium[],
) => Promise<Entry[]>;

// Recently played has no loader until a medium that joins it lands.
const coreShelves = {
  "continue-watching": { title: "Continue watching", load: continueEntries },
  "recently-added": { title: "Recently added", load: recentlyAdded },
} satisfies Partial<Record<CoreShelf, { title: string; load: ShelfLoader }>>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the plugin shelves for one placement into cards the user may view,
 * in the plugin's order. A shelf id is prefixed with its plugin's name.
 */
export async function pluginShelves(
  db: Database,
  userId: string,
  plugins: PluginRuntime,
  placement: "home" | "item",
  itemId?: string,
) {
  const resolved = await plugins.shelves(placement, { userId, itemId });
  if (resolved.length === 0) return [];
  const viewable = await viewableLibraryIds(db, userId);
  return Promise.all(
    resolved.map(async (shelf) => {
      const ids = shelf.itemIds
        .filter((id) => uuidPattern.test(id))
        .slice(0, shelfSize);
      const cards =
        ids.length === 0 || viewable.length === 0
          ? []
          : await browseCards(
              db,
              and(inArray(items.id, ids), inArray(items.libraryId, viewable)),
            );
      const byId = new Map(cards.map((card) => [card.id, card]));
      return {
        id: `${shelf.plugin}:${shelf.id}`,
        title: shelf.title,
        entries: ids.flatMap((id) => byId.get(id) ?? []).map(bare),
      };
    }),
  );
}

/**
 * Assembles Home from the mediums and plugins: continue watching, then each
 * medium's own shelves such as next up, then plugin shelves, then recently
 * added. A core shelf appears only when some medium joins it, and a shelf
 * with no entries is left out.
 */
export async function homeShelves(
  db: Database,
  userId: string,
  plugins?: PluginRuntime,
) {
  const mediums: Medium[] = [moviesMedium, createShowsMedium(db)];
  const core = (id: keyof typeof coreShelves) => {
    const joined = mediums.filter((medium) =>
      medium.browse.coreShelves.includes(id),
    );
    if (joined.length === 0) return [];
    const { title, load } = coreShelves[id];
    return [
      load(db, userId, joined).then((entries) => ({ id, title, entries })),
    ];
  };
  const own = mediums.flatMap((medium) =>
    medium.browse.shelves.map(async (shelf) => {
      const ids = (await shelf.items({ userId })).slice(0, shelfSize);
      const entries = (await browseCardsById(db, ids)).map(bare);
      return { id: shelf.id, title: shelf.title, entries };
    }),
  );
  const [leading, fromPlugins, trailing] = await Promise.all([
    Promise.all([...core("continue-watching"), ...own]),
    plugins === undefined ? [] : pluginShelves(db, userId, plugins, "home"),
    Promise.all(core("recently-added")),
  ]);
  return [...leading, ...fromPlugins, ...trailing].filter(
    (shelf) => shelf.entries.length > 0,
  );
}
