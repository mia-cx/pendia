import { timestamp, uuid } from "drizzle-orm/pg-core";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const owned = { onDelete: "cascade", onUpdate: "no action" } as const;

/** Defines an application-generated UUIDv7 primary key. */
export function id() {
  return uuid("id")
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7());
}

/** Defines a timezone-aware event timestamp. */
export function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}
