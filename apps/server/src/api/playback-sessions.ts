import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { Schema } from "effect";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  progress,
  sessionRegistry,
  transcoderCapabilities,
  users,
  versions,
} from "../db/schema/index.ts";
import type { SessionDecision } from "../playback/decisions.ts";
import { authenticated } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import { browseCardsById } from "./items.ts";
import { PlaybackSession } from "./schema.ts";

/** How long a session that is not stopped stays listed without a report from its player. */
export const sessionStaleSeconds = 300;

function rungsOf(
  decision: SessionDecision | null,
  storedRungs: ReadonlyMap<string, string>,
) {
  const stored = decision?.storedVariantIds ?? [];
  if (stored.length > 0)
    return stored.flatMap((id) => storedRungs.get(id) ?? []);
  if (
    decision !== null &&
    "video" in decision &&
    decision.video.action === "transcode"
  )
    return [`${decision.video.height}p`];
  return ["source"];
}

/** What a session's transcode converts: video, subtitles or HDR first, audio last; empty when nothing is re-encoded. */
export function transcodeReasons(
  decision: SessionDecision | null,
): ("video" | "audio" | "subtitles" | "hdr")[] {
  if (decision?.method !== "transcode") return [];
  const reasons: ("video" | "subtitles" | "hdr")[] = [];
  if (decision.video.action === "transcode") {
    if (decision.video.burnSubtitles) reasons.push("subtitles");
    else if (decision.video.toneMap !== null) reasons.push("hdr");
    else reasons.push("video");
  }
  return decision.audio?.action === "transcode"
    ? [...reasons, "audio"]
    : reasons;
}

/** Lists live and queued sessions, newest first, for a caller holding manage-server. */
export async function listPlaybackSessions(db: Database, actorId: string) {
  await requirePermission(db, actorId, "manage-server");
  const rows = await db
    .select({
      id: sessionRegistry.id,
      state: sessionRegistry.state,
      playMethod: sessionRegistry.playMethod,
      decision: sessionRegistry.decision,
      itemId: sessionRegistry.itemId,
      clientName: sessionRegistry.clientName,
      deviceName: sessionRegistry.deviceName,
      userId: users.id,
      displayName: users.displayName,
      versionId: versions.id,
      versionLabel: versions.label,
      versionDurationSeconds: versions.durationSeconds,
      positionSeconds: progress.positionSeconds,
      transcoder: transcoderCapabilities.name,
      createdAt: sessionRegistry.createdAt,
      lastSeenAt: sessionRegistry.lastSeenAt,
    })
    .from(sessionRegistry)
    .innerJoin(users, eq(users.id, sessionRegistry.userId))
    .innerJoin(versions, eq(versions.id, sessionRegistry.versionId))
    .leftJoin(
      progress,
      and(
        eq(progress.userId, sessionRegistry.userId),
        eq(progress.itemId, sessionRegistry.itemId),
      ),
    )
    .leftJoin(
      transcoderCapabilities,
      eq(transcoderCapabilities.id, sessionRegistry.transcoderNodeId),
    )
    .where(
      and(
        ne(sessionRegistry.state, "stopped"),
        gt(
          sessionRegistry.lastSeenAt,
          sql`clock_timestamp() - ${sessionStaleSeconds} * interval '1 second'`,
        ),
      ),
    )
    .orderBy(desc(sessionRegistry.createdAt), desc(sessionRegistry.id));
  const cards = new Map(
    (
      await browseCardsById(db, [...new Set(rows.map((row) => row.itemId))])
    ).map((card) => [card.id, card]),
  );
  const variantIds = rows.flatMap(
    (row) => row.decision?.storedVariantIds ?? [],
  );
  const storedRungs = new Map(
    variantIds.length === 0
      ? []
      : (
          await db
            .select({ id: versions.id, rung: versions.rung })
            .from(versions)
            .where(inArray(versions.id, variantIds))
        ).flatMap((row) => (row.rung === null ? [] : [[row.id, row.rung]])),
  );
  return rows.flatMap(
    ({
      itemId,
      userId,
      displayName,
      decision,
      versionId,
      versionLabel,
      versionDurationSeconds,
      ...row
    }) => {
      const item = cards.get(itemId);
      if (item === undefined) return [];
      return {
        ...row,
        user: { id: userId, displayName },
        item,
        version: {
          id: versionId,
          label: versionLabel,
          durationSeconds: versionDurationSeconds,
        },
        reasons: transcodeReasons(decision),
        rungs: rungsOf(decision, storedRungs),
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      };
    },
  );
}

/** Lists live and queued playback sessions; mounted as `playback.sessions`. */
export const playbackSessions = authenticated
  .route({ method: "GET", path: "/playback/sessions" })
  .output(Schema.standardSchemaV1(Schema.Array(PlaybackSession)))
  .handler(async ({ context }) =>
    runApi(
      fromHost(() => listPlaybackSessions(context.db, context.caller.user.id)),
    ),
  );
