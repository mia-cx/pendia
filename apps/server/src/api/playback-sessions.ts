import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { Schema } from "effect";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
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

/** Lists live and queued sessions, newest first, for a caller holding manage-server. */
export async function listSessions(db: Database, actorId: string) {
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
      transcoder: transcoderCapabilities.name,
      createdAt: sessionRegistry.createdAt,
      lastSeenAt: sessionRegistry.lastSeenAt,
    })
    .from(sessionRegistry)
    .innerJoin(users, eq(users.id, sessionRegistry.userId))
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
  return rows.flatMap(({ itemId, userId, displayName, decision, ...row }) => {
    const item = cards.get(itemId);
    if (item === undefined) return [];
    return {
      ...row,
      user: { id: userId, displayName },
      item,
      rungs: rungsOf(decision, storedRungs),
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    };
  });
}

/** Lists live and queued playback sessions; mounted as `playback.sessions`. */
export const playbackSessions = authenticated
  .route({ method: "GET", path: "/playback/sessions" })
  .output(Schema.standardSchemaV1(Schema.Array(PlaybackSession)))
  .handler(async ({ context }) =>
    runApi(fromHost(() => listSessions(context.db, context.caller.user.id))),
  );
