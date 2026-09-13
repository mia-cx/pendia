import { Schema } from "effect";
import { permissions } from "../db/schema/index.ts";
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
  medium: Schema.Literal("movies"),
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

/** The flat permission names the auth slice enforces. */
export const PermissionName = Schema.Literal(...permissions);

/** The account shape user creation returns. */
export const UserAccount = Schema.Struct({
  id: Schema.UUID,
  username: Schema.String,
  displayName: Schema.String,
});

/** The user shape the admin screens list and edit. */
export const AdminUser = Schema.Struct({
  id: Schema.UUID,
  username: Schema.String,
  displayName: Schema.String,
  email: Schema.NullOr(Schema.String),
  disabledAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

/** A permission group with its granted permission names. */
export const Group = Schema.Struct({
  id: Schema.UUID,
  name: Schema.String,
  builtIn: Schema.Boolean,
  permissions: Schema.Array(PermissionName),
});

/** The per-user bitrate cap and content-rating ceiling. */
export const UserSettings = Schema.Struct({
  bitrateCapBps: Schema.NullOr(Schema.Int),
  contentRatingCeiling: Schema.NullOr(Schema.String),
});

/** One user's full access shape behind the per-user screen. */
export const UserAccess = Schema.Struct({
  user: AdminUser,
  groupIds: Schema.Array(Schema.UUID),
  overrides: Schema.Array(
    Schema.Struct({ permission: PermissionName, allowed: Schema.Boolean }),
  ),
  libraryAccess: Schema.Array(
    Schema.Struct({ libraryId: Schema.UUID, allowed: Schema.Boolean }),
  ),
  settings: UserSettings,
});

/** A device session row the admin can inspect and revoke. */
export const Session = Schema.Struct({
  id: Schema.UUID,
  userId: Schema.UUID,
  clientName: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
  createdAt: Schema.String,
  lastSeenAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
});

/** The server settings the admin reads; no secret ever appears. */
export const ServerSettings = Schema.Struct({
  trustedProxyAddresses: Schema.Array(Schema.String),
  artworkRequiresAuth: Schema.Boolean,
  oidcConfigured: Schema.Boolean,
  providerKeys: Schema.Array(Schema.String),
});

/** The newest scan run's job counts and newest job for one library. */
export const ScanStatus = Schema.Struct({
  libraryId: Schema.UUID,
  counts: Schema.Struct({
    queued: Schema.Int,
    running: Schema.Int,
    completed: Schema.Int,
    failed: Schema.Int,
  }),
  latest: Schema.NullOr(
    Schema.Struct({
      id: Schema.UUID,
      state: Schema.Literal("queued", "running", "completed", "failed"),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  runId: Schema.NullOr(Schema.UUID),
});

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
