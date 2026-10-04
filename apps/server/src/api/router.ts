import { eventIterator } from "@orpc/server";
import { Schema } from "effect";
import { isBuiltInAdmin } from "../auth/permissions.ts";
import { refreshItem as queueItemRefresh } from "../metadata/jobs.ts";
import {
  groupProcedures,
  settingsProcedures,
  setupProcedures,
  userProcedures,
} from "./admin.ts";
import {
  authenticated,
  authenticatedMutation,
  authenticateRequest,
} from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import { getItemDetail, listItemCards, searchItems } from "./items.ts";
import { libraryProcedures } from "./libraries.ts";
import { markProcedures, shelfProcedures } from "./marks.ts";
import { playbackProcedures } from "./playback.ts";
import {
  ApiEvent,
  connection,
  ItemCard,
  ItemDetail,
  ItemKind,
  ItemSort,
  Me,
  PageSize,
} from "./schema.ts";

const me = authenticated
  .route({ method: "GET", path: "/me" })
  .output(Schema.standardSchemaV1(Me))
  .handler(async ({ context }) => ({
    ...context.caller,
    admin: await isBuiltInAdmin(context.db, context.caller.user.id),
  }));

const listItems = authenticated
  .route({ method: "GET", path: "/items" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        libraryId: Schema.optional(Schema.UUID),
        kind: Schema.optional(ItemKind),
        sort: Schema.optional(ItemSort),
        limit: Schema.optional(PageSize),
        cursor: Schema.optional(Schema.String),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(connection(ItemCard)))
  .handler(async ({ context, input }) =>
    runApi(listItemCards(context.db, context.caller, input)),
  );

const getItem = authenticated
  .route({ method: "GET", path: "/items/{id}" })
  .input(Schema.standardSchemaV1(Schema.Struct({ id: Schema.UUID })))
  .output(Schema.standardSchemaV1(ItemDetail))
  .handler(async ({ context, input }) =>
    runApi(getItemDetail(context.db, context.caller, input.id)),
  );

const refreshItem = authenticatedMutation
  .route({ method: "POST", path: "/items/{id}/refresh" })
  .input(Schema.standardSchemaV1(Schema.Struct({ id: Schema.UUID })))
  .output(Schema.standardSchemaV1(Schema.Struct({ jobId: Schema.UUID })))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        queueItemRefresh(context.db, context.caller.user.id, input.id),
      ),
    ),
  );

const SearchQuery = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(200),
  Schema.filter((query) => !query.includes("\0"), {
    message: () => "query must not contain NUL",
  }),
);

const search = authenticated
  .route({ method: "GET", path: "/search" })
  .input(Schema.standardSchemaV1(Schema.Struct({ query: SearchQuery })))
  .output(Schema.standardSchemaV1(Schema.Array(ItemCard)))
  .handler(async ({ context, input }) =>
    runApi(searchItems(context.db, context.caller, input.query)),
  );

const streamEvents = authenticated
  .route({ method: "GET", path: "/events" })
  .output(eventIterator(Schema.standardSchemaV1(ApiEvent)))
  .handler(async function* ({ context, lastEventId, signal }) {
    yield* context.events.subscribe({
      caller: context.caller,
      revalidate: () =>
        runApi(authenticateRequest(context.db, context.request)),
      lastEventId,
      signal,
    });
  });

/** The API router: procedures defined once, served over both RPC and REST. */
export const pendiaRouter = {
  me,
  items: { list: listItems, get: getItem, search, refresh: refreshItem },
  libraries: libraryProcedures,
  playback: playbackProcedures,
  marks: markProcedures,
  shelves: shelfProcedures,
  setup: setupProcedures,
  users: userProcedures,
  groups: groupProcedures,
  settings: settingsProcedures,
  events: { stream: streamEvents },
};
