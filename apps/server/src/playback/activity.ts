import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import {
  isBuiltInAdmin,
  requirePermission,
  viewableLibraryIds,
} from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { items, progress, sessionRegistry } from "../db/schema/index.ts";

/** Live playback expires from activity listings after five minutes without a player heartbeat. */
export const playbackActivitySeconds = 300;

/** Lists current plays owned by visible device sessions, scoped to the caller's account and library permissions. */
export async function listPlaybackActivity(
  db: Database,
  actorId: string,
  credentialIds: string[],
) {
  if (credentialIds.length === 0) return [];
  const [admin, libraries] = await Promise.all([
    isBuiltInAdmin(db, actorId),
    viewableLibraryIds(db, actorId),
  ]);
  if (libraries.length === 0) return [];
  return db
    .select({
      id: sessionRegistry.id,
      credentialId: sessionRegistry.credentialId,
      userId: sessionRegistry.userId,
      itemId: sessionRegistry.itemId,
      versionId: sessionRegistry.versionId,
      state: sessionRegistry.state,
      method: sessionRegistry.playMethod,
      decision: sessionRegistry.decision,
      positionSeconds: progress.positionSeconds,
      lastSeenAt: sessionRegistry.lastSeenAt,
    })
    .from(sessionRegistry)
    .innerJoin(items, eq(items.id, sessionRegistry.itemId))
    .leftJoin(
      progress,
      and(
        eq(progress.userId, sessionRegistry.userId),
        eq(progress.itemId, sessionRegistry.itemId),
      ),
    )
    .where(
      and(
        inArray(sessionRegistry.credentialId, credentialIds),
        admin ? undefined : eq(sessionRegistry.userId, actorId),
        inArray(items.libraryId, libraries),
        ne(sessionRegistry.state, "stopped"),
        gt(
          sessionRegistry.lastSeenAt,
          sql`clock_timestamp() - ${playbackActivitySeconds} * interval '1 second'`,
        ),
      ),
    )
    .orderBy(desc(sessionRegistry.createdAt), desc(sessionRegistry.id));
}

/** Renews one owned playback session without changing its state, position, or play count. */
export async function pingPlayback(db: Database, actorId: string, id: string) {
  const [session] = await db
    .select({ userId: sessionRegistry.userId, libraryId: items.libraryId })
    .from(sessionRegistry)
    .innerJoin(items, eq(items.id, sessionRegistry.itemId))
    .where(eq(sessionRegistry.id, id));
  if (session === undefined) throw new AuthError("NOT_FOUND");
  if (session.userId !== actorId) throw new AuthError("FORBIDDEN");
  await requirePermission(db, actorId, "view", session.libraryId);
  await requirePermission(db, actorId, "play");
  await db
    .update(sessionRegistry)
    .set({ lastSeenAt: new Date() })
    .where(
      and(eq(sessionRegistry.id, id), ne(sessionRegistry.state, "stopped")),
    );
}
