import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

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

/**
 * Defines a jsonb column; narrow it with `$type<T>()`.
 * Drizzle's own jsonb stringifies values and Bun SQL then stores that text as a
 * JSON string, so this sends the JSON as text and casts it. Without `::text`,
 * Bun would encode the string again for the jsonb parameter.
 */
export const jsonb = customType<{ data: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => sql`${JSON.stringify(value)}::text::jsonb`,
});

/** Defines a timezone-aware event timestamp. */
export function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}
