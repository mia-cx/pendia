import { eq } from "drizzle-orm";
import { Schema } from "effect";
import type { Database } from "../db/client.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { settings } from "../db/schema/index.ts";
import { hlsCopyVideo } from "../playback/decisions.ts";

/** The rung that remuxes the source into the stored layout without re-encoding. */
export const sourceRungName = "source";

/** A rung name; names become folder names, so they stay short and path safe. */
export const RungName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9_-]{0,31}$/),
);

/** A stored rung: the source remux, or H.264 at a height and bitrate with AAC stereo. */
export const Rung = Schema.Union(
  Schema.Struct({ name: Schema.Literal(sourceRungName) }),
  Schema.Struct({
    name: RungName.pipe(Schema.filter((name) => name !== sourceRungName)),
    height: Schema.Int.pipe(
      Schema.between(144, 4320),
      Schema.filter((height) => height % 2 === 0),
    ),
    bitrate: Schema.Int.pipe(Schema.between(100_000, 200_000_000)),
  }),
);

/** One rung of a library policy. */
export type Rung = typeof Rung.Type;

/** A per-library policy: the rungs to store and the condition a source must meet. */
export const StoredVersionPolicy = Schema.Struct({
  rungs: Schema.Array(Rung).pipe(
    Schema.minItems(1),
    Schema.maxItems(8),
    Schema.filter(
      (rungs) => new Set(rungs.map((rung) => rung.name)).size === rungs.length,
    ),
  ),
  // Any one present criterion matches; no condition matches every source.
  when: Schema.optional(
    Schema.Struct({
      minHeight: Schema.optional(Schema.Int.pipe(Schema.positive())),
      codecs: Schema.optional(
        Schema.Array(Schema.String.pipe(Schema.minLength(1))),
      ),
      // A criterion that matches HDR sources; there is no "SDR only" criterion.
      hdr: Schema.optional(Schema.Literal(true)),
    }),
  ),
  // Excess keys fail, so an encoded rung named "source" cannot pass as the remux.
}).annotations({ parseOptions: { onExcessProperty: "error" } });

/** A decoded library policy. */
export type StoredVersionPolicy = typeof StoredVersionPolicy.Type;

/** Reads the policy from a library's configuration; null when the library stores nothing. */
export function readStoredVersionPolicy(configuration: JsonObject) {
  const raw = configuration.storedVersions;
  if (raw === undefined || raw === null) return null;
  return Schema.decodeUnknownSync(StoredVersionPolicy)(raw);
}

/** The video facts of a source that the policy looks at. */
export type SourceVideo = { codec: string; height: number; hdr: string };

/** Returns whether a source meets the policy condition. */
export function policyMatches(
  when: StoredVersionPolicy["when"],
  video: SourceVideo,
) {
  if (when === undefined) return true;
  return (
    (when.minHeight !== undefined && video.height >= when.minHeight) ||
    (when.codecs?.includes(video.codec) ?? false) ||
    (when.hdr === true && video.hdr !== "sdr")
  );
}

/** Returns whether a rung can be made from a source: a copyable codec for the remux, no upscaling for an encode. */
export function rungFits(rung: Rung, video: SourceVideo) {
  return "height" in rung
    ? rung.height <= video.height
    : hlsCopyVideo.has(video.codec);
}

/** A daily window in server local time, as "HH:MM"; equal ends mean all day. */
export type IdleWindow = { start: string; end: string };

const clock = Schema.String.pipe(Schema.pattern(/^([01]\d|2[0-3]):[0-5]\d$/));

const StoreSettings = Schema.Struct({
  idleWindow: Schema.optional(Schema.Struct({ start: clock, end: clock })),
});

/** The window store jobs run in when the `store` settings row names none. */
export const defaultIdleWindow: IdleWindow = { start: "01:00", end: "07:00" };

/** Reads the store settings row and applies the default idle window. */
export async function readStoreSettings(db: Database) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "store"))
    .limit(1);
  const decoded = Schema.decodeUnknownSync(StoreSettings)(row?.value ?? {});
  return { idleWindow: decoded.idleWindow ?? defaultIdleWindow };
}

const minutes = (value: string) => {
  const [hours = 0, mins = 0] = value.split(":").map(Number);
  return hours * 60 + mins;
};

const at = (day: Date, offsetDays: number, clockMinutes: number) =>
  new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() + offsetDays,
    Math.floor(clockMinutes / 60),
    clockMinutes % 60,
  );

/** Places a moment against the idle window: inside with its end (null all day), or outside with the next start. */
export function idleWindowAt(window: IdleWindow, now: Date) {
  const start = minutes(window.start);
  const end = minutes(window.end);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return { inside: true as const, endsAt: null };
  if (start < end) {
    if (current >= start && current < end)
      return { inside: true as const, endsAt: at(now, 0, end) };
    return {
      inside: false as const,
      startsAt: at(now, current < start ? 0 : 1, start),
    };
  }
  // The window crosses midnight.
  if (current >= start)
    return { inside: true as const, endsAt: at(now, 1, end) };
  if (current < end) return { inside: true as const, endsAt: at(now, 0, end) };
  return { inside: false as const, startsAt: at(now, 0, start) };
}
