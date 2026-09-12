import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Schema } from "effect";
import { Effect } from "effect";
import { AuthError } from "../auth/errors.ts";
import { requirePermission, viewableLibraryIds } from "../auth/permissions.ts";
import type { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { items } from "../db/schema/index.ts";
import { ApiError, fromHost } from "./errors.ts";
import { after, decodeCursor, defaultPageSize, toPage } from "./pagination.ts";
import type { ItemKind } from "./schema.ts";

/** The authenticated caller the middleware places in context. */
export type Caller = Awaited<ReturnType<typeof authenticate>>;

/** The decoded items.list input. */
export type ListItemsInput = {
  readonly libraryId?: string;
  readonly kind?: Schema.Schema.Type<typeof ItemKind>;
  readonly limit?: number;
  readonly cursor?: string;
};

// Instants cross the API as the database's own UTC text at microsecond
// precision, so a cursor never rounds a timestamp the driver truncated.
const instantText = (column: typeof items.addedAt) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const cardFields = {
  id: items.id,
  kind: items.kind,
  libraryId: items.libraryId,
  title: items.title,
  year: items.year,
  addedAt: instantText(items.addedAt),
};

const detailFields = {
  ...cardFields,
  parentId: items.parentId,
  overview: items.overview,
  contentRating: items.contentRating,
  genres: items.genres,
  tags: items.tags,
  updatedAt: instantText(items.updatedAt),
};

/** Lists item cards newest first, paginated by the opaque cursor. */
export function listItemCards(
  db: Database,
  caller: Caller,
  input: ListItemsInput,
) {
  return Effect.gen(function* () {
    // Without a library the list is scoped to every library the caller may view.
    const scope = yield* fromHost(async () => {
      if (input.libraryId !== undefined) {
        await requirePermission(db, caller.user.id, "view", input.libraryId);
        return eq(items.libraryId, input.libraryId);
      }
      const viewable = await viewableLibraryIds(db, caller.user.id);
      if (viewable.length === 0) throw new AuthError("FORBIDDEN");
      return inArray(items.libraryId, viewable);
    });
    const limit = input.limit ?? defaultPageSize;
    const key =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    if (input.cursor !== undefined && key === undefined)
      return yield* new ApiError({
        code: "BAD_REQUEST",
        reason: "Unknown cursor.",
      });
    const rows = yield* fromHost(() =>
      db
        .select(cardFields)
        .from(items)
        .where(
          and(
            scope,
            input.kind === undefined ? undefined : eq(items.kind, input.kind),
            key === undefined ? undefined : after(key),
          ),
        )
        .orderBy(desc(items.addedAt), desc(items.id))
        .limit(limit + 1),
    );
    const page = toPage(rows, limit, (row) => ({
      addedAt: row.addedAt,
      id: row.id,
    }));
    return {
      items: page.items,
      cursor: page.cursor,
    };
  });
}

/** Reads one item's detail, checking access to the library that holds it. */
export function getItemDetail(db: Database, caller: Caller, id: string) {
  return Effect.gen(function* () {
    const [row] = yield* fromHost(() =>
      db.select(detailFields).from(items).where(eq(items.id, id)).limit(1),
    );
    if (!row) return yield* new ApiError({ code: "NOT_FOUND" });
    yield* fromHost(() =>
      requirePermission(db, caller.user.id, "view", row.libraryId),
    );
    return row;
  });
}
