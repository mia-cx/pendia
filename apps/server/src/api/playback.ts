import { Schema } from "effect";
import { planPlayback, refreshPlayback } from "../playback/planning.ts";
import { authenticatedMutation } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";

const shortString = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
);
const positiveInt = Schema.Int.pipe(Schema.positive());
const bounded = <A, I, R>(item: Schema.Schema<A, I, R>) =>
  Schema.Array(item).pipe(Schema.maxItems(128));

const VideoCodecInput = Schema.Struct({
  codec: shortString,
  profiles: Schema.optional(bounded(shortString)),
  maxLevel: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(0))),
  maxWidth: Schema.optional(positiveInt),
  maxHeight: Schema.optional(positiveInt),
});

const AudioCodecInput = Schema.Struct({
  codec: shortString,
  maxChannels: positiveInt,
});

const ClientProfileInput = Schema.Struct({
  containers: bounded(shortString),
  videoCodecs: bounded(VideoCodecInput).pipe(Schema.minItems(1)),
  audioCodecs: bounded(AudioCodecInput),
  subtitleFormats: bounded(shortString),
  hdr: bounded(Schema.Literal("sdr", "hdr10", "hdr10+", "hlg", "dolby-vision")),
  maxBitrate: Schema.optional(Schema.NullOr(positiveInt)),
});

const PlanInput = Schema.Struct({
  itemId: Schema.UUID,
  versionId: Schema.UUID,
  profile: ClientProfileInput,
  bitrateCapBps: Schema.optional(positiveInt),
});

const PlanOutput = Schema.Struct({
  method: Schema.Literal("direct-play", "remux", "transcode"),
  itemId: Schema.UUID,
  versionId: Schema.UUID,
  sessionId: Schema.NullOr(Schema.UUID),
  url: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
});

const plan = authenticatedMutation
  .route({ method: "POST", path: "/playback/plan" })
  .input(Schema.standardSchemaV1(PlanInput))
  .output(Schema.standardSchemaV1(PlanOutput))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        planPlayback(context.db, context.caller, input, {
          request: context.request,
          peerAddress: context.peerAddress,
        }),
      ),
    ),
  );

const refresh = authenticatedMutation
  .route({ method: "POST", path: "/playback/{sessionId}/{itemId}/refresh" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({ sessionId: Schema.UUID, itemId: Schema.UUID }),
    ),
  )
  .output(Schema.standardSchemaV1(PlanOutput))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        refreshPlayback(
          context.db,
          context.caller,
          { sessionId: input.sessionId, itemId: input.itemId },
          { request: context.request, peerAddress: context.peerAddress },
        ),
      ),
    ),
  );

/** The playback planning procedures mounted under `playback`. */
export const playbackProcedures = { plan, refresh };
