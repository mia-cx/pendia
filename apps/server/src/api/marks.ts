import { Schema } from "effect";
import { createShowsMedium } from "../mediums/shows.ts";
import {
  continueWatching as continueWatchingItems,
  getItemMarks,
  setFavourite as saveFavourite,
  setRating as saveRating,
} from "../playback/marks.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import { Progress } from "./progress.ts";
import { connection, ItemCard, PageSize } from "./schema.ts";

const Marks = Schema.Struct({
  favourite: Schema.Boolean,
  rating: Schema.NullOr(Schema.Number),
});

const RatingInput = Schema.NullOr(
  Schema.Number.pipe(
    Schema.finite(),
    Schema.greaterThanOrEqualTo(0),
    Schema.lessThanOrEqualTo(10),
    Schema.filter((value) => Math.round(value * 10) / 10 === value, {
      message: () => "rating accepts at most one decimal",
    }),
  ),
);

const get = authenticated
  .route({ method: "GET", path: "/items/{itemId}/marks" })
  .input(Schema.standardSchemaV1(Schema.Struct({ itemId: Schema.UUID })))
  .output(Schema.standardSchemaV1(Marks))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        getItemMarks(context.db, context.caller.user.id, input.itemId),
      ),
    ),
  );

const setFavourite = authenticatedMutation
  .route({ method: "PUT", path: "/items/{itemId}/favourite" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        itemId: Schema.UUID,
        favourite: Schema.Boolean,
      }),
    ),
  )
  .output(Schema.standardSchemaV1(Marks))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        saveFavourite(
          context.db,
          context.caller.user.id,
          input.itemId,
          input.favourite,
        ),
      ),
    ),
  );

const setRating = authenticatedMutation
  .route({ method: "PUT", path: "/items/{itemId}/rating" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({ itemId: Schema.UUID, rating: RatingInput }),
    ),
  )
  .output(Schema.standardSchemaV1(Marks))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        saveRating(
          context.db,
          context.caller.user.id,
          input.itemId,
          input.rating,
        ),
      ),
    ),
  );

const ContinueItem = Schema.Struct({
  item: ItemCard,
  progress: Progress,
  durationSeconds: Schema.NullOr(Schema.Number),
});

const continueWatching = authenticated
  .route({ method: "GET", path: "/shelves/continue-watching" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        limit: Schema.optional(PageSize),
        cursor: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(connection(ContinueItem)))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        continueWatchingItems(context.db, context.caller.user.id, {
          limit: input.limit,
          cursor: input.cursor,
        }),
      ),
    ),
  );

const nextUp = authenticated
  .route({ method: "GET", path: "/shelves/next-up" })
  .output(Schema.standardSchemaV1(Schema.Array(Schema.UUID)))
  .handler(async ({ context }) => {
    const shelf = createShowsMedium(context.db).browse.shelves.find(
      (candidate) => candidate.id === "next-up",
    );
    if (!shelf) throw new Error("Shows medium did not register next up.");
    return runApi(
      fromHost(() => shelf.items({ userId: context.caller.user.id })),
    );
  });

/** The per-user favourite and rating procedures mounted under `marks`. */
export const markProcedures = { get, setFavourite, setRating };

/** The shelf read procedures mounted under `shelves`. */
export const shelfProcedures = { continueWatching, nextUp };
