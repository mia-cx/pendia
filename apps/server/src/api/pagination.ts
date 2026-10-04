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

/** The sort position a title cursor points at, in A to Z order. */
export type TitleKey = { title: string; id: string };

const titleCursorPrefix = "t1.";

/** Encodes a title-order key as an opaque cursor, prefixed so no other order accepts it. */
export function encodeTitleCursor(key: TitleKey): string {
  return `${titleCursorPrefix}${Buffer.from(JSON.stringify([key.title, key.id])).toString("base64url")}`;
}

/** Decodes a title-order cursor, returning undefined for anything that is not one. */
export function decodeTitleCursor(cursor: string): TitleKey | undefined {
  if (!cursor.startsWith(titleCursorPrefix)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(cursor.slice(titleCursorPrefix.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
  const [title, id] = decoded;
  if (typeof title !== "string" || title.includes("\0")) return undefined;
  if (typeof id !== "string" || !uuidPattern.test(id)) return undefined;
  return { title, id };
}

/** The keyset predicate selecting rows past the cursor in title order. */
export function afterTitle(key: TitleKey) {
  return sql`(${items.title}, ${items.id}) > (${key.title}, ${key.id}::uuid)`;
}

/** Assembles a page from a limit+1 fetch, encoding the last kept row as the cursor. */
export function toPageBy<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => string,
): Page<T> {
  if (rows.length <= limit) return { items: rows, cursor: null };
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return { items: kept, cursor: last === undefined ? null : cursorOf(last) };
}

/** Assembles a page from a limit+1 fetch, emitting a cursor only when more rows remain. */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  key: (row: T) => PageKey,
): Page<T> {
  return toPageBy(rows, limit, (row) => encodeCursor(key(row)));
}
