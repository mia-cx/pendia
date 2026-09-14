import { Schema } from "effect";
import { maxPageSize } from "./pagination.ts";

/** The kinds of library item the API exposes. */
export const ItemKind = Schema.Literal("movie", "show", "season", "episode");

/** The item shape returned by list endpoints. */
export const ItemCard = Schema.Struct({
  id: Schema.UUID,
  kind: ItemKind,
  libraryId: Schema.UUID,
  title: Schema.String,
  year: Schema.NullOr(Schema.Int),
  addedAt: Schema.String,
  posterArtworkId: Schema.NullOr(Schema.UUID),
});

/** The item shape returned by detail endpoints. */
export const ItemDetail = Schema.Struct({
  ...ItemCard.fields,
  parentId: Schema.NullOr(Schema.UUID),
  overview: Schema.NullOr(Schema.String),
  contentRating: Schema.NullOr(Schema.String),
  genres: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  updatedAt: Schema.String,
});

/** The library shape returned by library endpoints. */
export const Library = Schema.Struct({
  id: Schema.UUID,
  name: Schema.String,
  medium: Schema.Literal("movies", "shows"),
  rootPath: Schema.String,
});

/** The fields accepted when a library is created. */
export const LibraryInput = Schema.Struct({
  name: Schema.String,
  medium: Schema.Literal("movies", "shows"),
  rootPath: Schema.String,
});

/** The authenticated caller returned by the me procedure. */
export const Me = Schema.Struct({
  user: Schema.Struct({
    id: Schema.UUID,
    username: Schema.String,
    displayName: Schema.String,
  }),
  credential: Schema.Struct({
    kind: Schema.Literal("session", "api-key"),
    id: Schema.UUID,
  }),
});

/** The page size input: REST sends a query string, RPC a number. */
export const PageSize = Schema.Union(
  Schema.Number,
  Schema.NumberFromString,
).pipe(
  Schema.filter(
    (size) => Number.isInteger(size) && size >= 1 && size <= maxPageSize,
    {
      message: () =>
        `limit must be an integer from 1 to ${maxPageSize}, inclusive`,
    },
  ),
);

/** Builds a paginated connection shape over an item schema. */
export function connection<A, I, R>(item: Schema.Schema<A, I, R>) {
  return Schema.Struct({
    items: Schema.Array(item),
    cursor: Schema.NullOr(Schema.String),
  });
}

/** A cross-process event streamed to subscribed clients. */
export const ApiEvent = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("library.changed"),
    libraryId: Schema.UUID,
  }),
  Schema.Struct({
    kind: Schema.Literal("job.progress"),
    jobId: Schema.UUID,
    state: Schema.Literal("queued", "running", "completed", "failed"),
  }),
  Schema.Struct({
    kind: Schema.Literal("session.state"),
    sessionId: Schema.UUID,
    state: Schema.Literal("queued", "starting", "playing", "stopped"),
  }),
  Schema.Struct({
    kind: Schema.Literal("segment.ready"),
    sessionId: Schema.UUID,
    index: Schema.Int,
  }),
);
