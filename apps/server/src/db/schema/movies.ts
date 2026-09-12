import { sql } from "drizzle-orm";
import { check, date, foreignKey, pgTable, uuid } from "drizzle-orm/pg-core";
import { itemKind, items } from "./core.ts";

export const movies = pgTable(
  "movies",
  {
    itemId: uuid("item_id").primaryKey(),
    kind: itemKind("kind").notNull().default("movie"),
    releaseDate: date("release_date"),
  },
  (table) => [
    check("movies_kind_check", sql`${table.kind} = 'movie'`),
    foreignKey({
      name: "movies_item_kind_fk",
      columns: [table.itemId, table.kind],
      foreignColumns: [items.id, items.kind],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
  ],
);
