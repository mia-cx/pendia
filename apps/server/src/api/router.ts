import { eventIterator } from "@orpc/server";
import { Schema } from "effect";
import { authenticated, authenticateRequest } from "./context.ts";
import { runApi } from "./errors.ts";
import { getItemDetail, listItemCards } from "./items.ts";
import { libraryProcedures } from "./libraries.ts";
import {
  ApiEvent,
  connection,
  ItemCard,
  ItemDetail,
  ItemKind,
  Me,
  PageSize,
} from "./schema.ts";

const me = authenticated
  .route({ method: "GET", path: "/me" })
  .output(Schema.standardSchemaV1(Me))
  .handler(async ({ context }) => context.caller);

const listItems = authenticated
  .route({ method: "GET", path: "/items" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        libraryId: Schema.optional(Schema.UUID),
        kind: Schema.optional(ItemKind),
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
  items: { list: listItems, get: getItem },
  libraries: libraryProcedures,
  events: { stream: streamEvents },
};
