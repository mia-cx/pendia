import { Schema } from "effect";
import {
  getProgress as readProgress,
  resumeProgress,
  startPlayback,
  stopPlayback,
  updatePlayback,
} from "../playback/progress.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";

const position = Schema.Number.pipe(
  Schema.finite(),
  Schema.greaterThanOrEqualTo(0),
);

const Progress = Schema.Struct({
  userId: Schema.UUID,
  itemId: Schema.UUID,
  versionId: Schema.NullOr(Schema.UUID),
  format: Schema.Literal("video", "audio", "ebook", "image"),
  positionSeconds: Schema.Number,
  completed: Schema.Boolean,
  playedAt: Schema.NullOr(Schema.String),
  playCount: Schema.Int,
  updatedAt: Schema.String,
});

const Lifecycle = Schema.Struct({
  state: Schema.Literal("playing", "stopped"),
  progress: Schema.NullOr(Progress),
});

const SessionScope = Schema.Struct({
  sessionId: Schema.UUID,
  itemId: Schema.UUID,
});

const getProgress = authenticated
  .route({ method: "GET", path: "/items/{itemId}/progress" })
  .input(Schema.standardSchemaV1(Schema.Struct({ itemId: Schema.UUID })))
  .output(Schema.standardSchemaV1(Schema.NullOr(Progress)))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        readProgress(context.db, context.caller.user.id, input.itemId),
      ),
    ),
  );

const resume = authenticated
  .route({
    method: "GET",
    path: "/items/{itemId}/versions/{versionId}/resume",
  })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({ itemId: Schema.UUID, versionId: Schema.UUID }),
    ),
  )
  .output(
    Schema.standardSchemaV1(Schema.Struct({ positionSeconds: Schema.Number })),
  )
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        resumeProgress(
          context.db,
          context.caller.user.id,
          input.itemId,
          input.versionId,
        ),
      ),
    ),
  );

const start = authenticatedMutation
  .route({ method: "POST", path: "/playback/{sessionId}/{itemId}/start" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        ...SessionScope.fields,
        positionSeconds: Schema.optional(position),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(Lifecycle))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        startPlayback(
          context.db,
          context.caller.user.id,
          { sessionId: input.sessionId, itemId: input.itemId },
          input.positionSeconds,
        ),
      ),
    ),
  );

const heartbeat = authenticatedMutation
  .route({ method: "POST", path: "/playback/{sessionId}/{itemId}/progress" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        ...SessionScope.fields,
        positionSeconds: position,
        completed: Schema.optional(Schema.Boolean),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(Lifecycle))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        updatePlayback(
          context.db,
          context.caller.user.id,
          { sessionId: input.sessionId, itemId: input.itemId },
          {
            positionSeconds: input.positionSeconds,
            completed: input.completed,
          },
        ),
      ),
    ),
  );

const stop = authenticatedMutation
  .route({ method: "POST", path: "/playback/{sessionId}/{itemId}/stop" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        ...SessionScope.fields,
        positionSeconds: position,
        completed: Schema.optional(Schema.Boolean),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(Lifecycle))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        stopPlayback(
          context.db,
          context.caller.user.id,
          { sessionId: input.sessionId, itemId: input.itemId },
          {
            positionSeconds: input.positionSeconds,
            completed: input.completed,
          },
        ),
      ),
    ),
  );

/** The playback progress and session lifecycle procedures mounted under `playback`. */
export const progressProcedures = {
  getProgress,
  resume,
  start,
  progress: heartbeat,
  stop,
};
