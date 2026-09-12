import { sql } from "drizzle-orm";
import { items } from "../db/schema/index.ts";

/** One page of a paginated list and the cursor for the next page. */
export type Page<T> = { items: readonly T[]; cursor: string | null };

/** The sort position a cursor points at, in newest-first order. */
export type PageKey = { addedAt: string; id: string };

/** The number of rows a list returns when no size is given. */
export const defaultPageSize = 24;

/** The largest page size a list accepts. */
export const maxPageSize = 100;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/;

/** Encodes a page key as an opaque base64url cursor. */
export function encodeCursor(key: PageKey): string {
  return Buffer.from(`${key.addedAt}|${key.id}`).toString("base64url");
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
  if (!instantPattern.test(stamp)) return undefined;
  // Reject rolled-over dates such as 2026-02-30: the parsed instant must keep
  // the stamp's millisecond prefix, leaving the trailing fraction untouched.
  const parsed = new Date(stamp);
  if (
    Number.isNaN(parsed.getTime()) ||
    !stamp.startsWith(parsed.toISOString().slice(0, -1))
  )
    return undefined;
  if (!uuidPattern.test(id)) return undefined;
  return { addedAt: stamp, id };
}

/** The keyset predicate selecting rows past the cursor in newest-first order. */
export function after(key: PageKey) {
  return sql`(${items.addedAt}, ${items.id}) < (${key.addedAt}::timestamptz, ${key.id}::uuid)`;
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
