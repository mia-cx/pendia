import { sql } from "drizzle-orm";
import { items } from "../db/schema/index.ts";

/** One page of a paginated list and the cursor for the next page. */
export type Page<T> = { items: readonly T[]; cursor: string | null };

/** The sort position a cursor points at, in newest-first order. */
export type PageKey = { addedAt: Date; id: string };

/** The number of rows a list returns when no size is given. */
export const defaultPageSize = 24;

/** The largest page size a list accepts. */
export const maxPageSize = 100;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes a page key as an opaque base64url cursor. */
export function encodeCursor(key: PageKey): string {
  return Buffer.from(`${key.addedAt.toISOString()}|${key.id}`).toString(
    "base64url",
  );
}

/** Decodes a cursor, returning undefined for anything that is not one of ours. */
export function decodeCursor(cursor: string): PageKey | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const [stamp, id, ...rest] = decoded.split("|");
  if (stamp === undefined || id === undefined || rest.length > 0)
    return undefined;
  const addedAt = new Date(stamp);
  if (Number.isNaN(addedAt.getTime()) || addedAt.toISOString() !== stamp)
    return undefined;
  if (!uuidPattern.test(id)) return undefined;
  return { addedAt, id };
}

/** The keyset predicate selecting rows past the cursor in newest-first order. */
export function after(key: PageKey) {
  return sql`(${items.addedAt}, ${items.id}) < (${key.addedAt.toISOString()}::timestamptz, ${key.id}::uuid)`;
}

/** Assembles a page from a limit+1 fetch, emitting a cursor only when more rows remain. */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  key: (row: T) => PageKey,
): Page<T> {
  if (rows.length > limit) {
    const kept = rows.slice(0, limit);
    const last = kept.at(-1);
    return {
      items: kept,
      cursor: last === undefined ? null : encodeCursor(key(last)),
    };
  }
  return { items: rows, cursor: null };
}
