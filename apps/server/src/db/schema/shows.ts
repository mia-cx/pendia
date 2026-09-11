import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { owned } from "./common.ts";
import { itemKind, items } from "./core.ts";

// Providers normalize status at ingestion when their mappings are defined.
export type ShowStatus = string;

export const shows = pgTable(
  "shows",
  {
    itemId: uuid("item_id").primaryKey(),
    kind: itemKind("kind").notNull().default("show"),
    firstAirDate: date("first_air_date"),
    lastAirDate: date("last_air_date"),
    status: text("status").$type<ShowStatus>(),
  },
  (table) => [
    check("shows_kind_check", sql`${table.kind} = 'show'`),
    foreignKey({
      name: "shows_item_kind_fk",
      columns: [table.itemId, table.kind],
      foreignColumns: [items.id, items.kind],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
  ],
);

export const seasons = pgTable(
  "seasons",
  {
    itemId: uuid("item_id").primaryKey(),
    kind: itemKind("kind").notNull().default("season"),
    showId: uuid("show_id")
      .notNull()
      .references(() => shows.itemId, owned),
    seasonNumber: integer("season_number").notNull(),
    airDate: date("air_date"),
  },
  (table) => [
    check("seasons_kind_check", sql`${table.kind} = 'season'`),
    check("seasons_number_check", sql`${table.seasonNumber} >= 0`),
    foreignKey({
      name: "seasons_item_kind_fk",
      columns: [table.itemId, table.kind],
      foreignColumns: [items.id, items.kind],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    unique("seasons_show_number_unique").on(table.showId, table.seasonNumber),
  ],
);

// The migration adds a GiST exclusion constraint for overlapping episode ranges within a season.
export const episodes = pgTable(
  "episodes",
  {
    itemId: uuid("item_id").primaryKey(),
    kind: itemKind("kind").notNull().default("episode"),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.itemId, owned),
    episodeNumber: integer("episode_number").notNull(),
    episodeEndNumber: integer("episode_end_number"),
    airDate: date("air_date"),
  },
  (table) => [
    check("episodes_kind_check", sql`${table.kind} = 'episode'`),
    check("episodes_number_check", sql`${table.episodeNumber} >= 0`),
    check(
      "episodes_end_number_check",
      sql`${table.episodeEndNumber} >= ${table.episodeNumber}`,
    ),
    foreignKey({
      name: "episodes_item_kind_fk",
      columns: [table.itemId, table.kind],
      foreignColumns: [items.id, items.kind],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    unique("episodes_season_number_unique").on(
      table.seasonId,
      table.episodeNumber,
    ),
  ],
);
