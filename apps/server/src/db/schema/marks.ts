import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./access.ts";
import { id, instant, owned } from "./common.ts";
import { format, items, versions } from "./core.ts";

export const progress = pgTable(
  "progress",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, owned),
    // A missing Version needs compatibility checks before its position can resume.
    versionId: uuid("version_id"),
    format: format("format").notNull(),
    positionSeconds: doublePrecision("position_seconds").notNull().default(0),
    completed: boolean("completed").notNull().default(false),
    playedAt: instant("played_at"),
    playCount: integer("play_count").notNull().default(0),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("progress_user_item_unique").on(table.userId, table.itemId),
    // The migration narrows SET NULL to version_id; Drizzle cannot express its column list.
    foreignKey({
      name: "progress_version_fk",
      columns: [table.versionId, table.itemId, table.format],
      foreignColumns: [versions.id, versions.itemId, versions.format],
    })
      .onDelete("set null")
      .onUpdate("no action"),
    check(
      "progress_position_check",
      sql`${table.positionSeconds} >= 0 and ${table.positionSeconds} < 'Infinity'::float8`,
    ),
    check("progress_play_count_check", sql`${table.playCount} >= 0`),
    index("progress_recent_idx").on(
      table.userId,
      table.playedAt.desc(),
      table.itemId,
    ),
    index("progress_continue_idx")
      .on(table.userId, table.playedAt.desc(), table.itemId)
      .where(sql`not ${table.completed} and ${table.positionSeconds} > 0`),
    index("progress_item_idx").on(table.itemId, table.userId),
  ],
);

export const favourites = pgTable(
  "favourites",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, owned),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("favourites_user_item_unique").on(table.userId, table.itemId),
    index("favourites_recent_idx").on(
      table.userId,
      table.createdAt.desc(),
      table.itemId,
    ),
  ],
);

export const ratings = pgTable(
  "ratings",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, owned),
    value: numeric("value", { precision: 3, scale: 1 }).notNull(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("ratings_user_item_unique").on(table.userId, table.itemId),
    check(
      "ratings_value_check",
      sql`${table.value} >= 0 and ${table.value} <= 10`,
    ),
  ],
);
