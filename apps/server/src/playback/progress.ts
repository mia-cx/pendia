import { and, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { publishEvent } from "../api/events.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import {
  items,
  progress,
  sessionRegistry,
  versions,
} from "../db/schema/index.ts";

type ProgressDb = Pick<Database, "select">;
type LifecycleDb = Pick<
  Database,
  "select" | "insert" | "update" | "execute" | "transaction"
>;
type Scope = { sessionId: string; itemId: string };
type ProgressRow = typeof progress.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

function toProgress(row: ProgressRow) {
  return {
    userId: row.userId,
    itemId: row.itemId,
    versionId: row.versionId,
    format: row.format,
    positionSeconds: row.positionSeconds,
    completed: row.completed,
    playedAt: row.playedAt === null ? null : row.playedAt.toISOString(),
    playCount: row.playCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readProgressRow(db: ProgressDb, userId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(progress)
    .where(and(eq(progress.userId, userId), eq(progress.itemId, itemId)))
    .limit(1);
  return row;
}

async function readProgress(db: ProgressDb, userId: string, itemId: string) {
  const row = await readProgressRow(db, userId, itemId);
  return row === undefined ? null : toProgress(row);
}

async function requireViewableItem(
  db: ProgressDb,
  userId: string,
  itemId: string,
) {
  const [item] = await db
    .select({ libraryId: items.libraryId })
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (item === undefined) throw new AuthError("NOT_FOUND");
  await requirePermission(db, userId, "view", item.libraryId);
}

function clampPosition(position: number, durationSeconds: number | null) {
  return durationSeconds === null
    ? position
    : Math.min(position, durationSeconds);
}

async function resumePosition(
  db: ProgressDb,
  userId: string,
  itemId: string,
  target: VersionRow,
): Promise<number> {
  const row = await readProgressRow(db, userId, itemId);
  if (
    row === undefined ||
    row.completed ||
    row.versionId === null ||
    row.format !== target.format
  )
    return 0;
  if (row.versionId === target.id)
    return clampPosition(row.positionSeconds, target.durationSeconds);
  const [source] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.id, row.versionId), eq(versions.itemId, itemId)))
    .limit(1);
  if (
    source === undefined ||
    source.format !== target.format ||
    target.segmentTimelineId === null ||
    source.segmentTimelineId !== target.segmentTimelineId
  )
    return 0;
  return clampPosition(row.positionSeconds, target.durationSeconds);
}

/** Reads the caller's stored progress for an Item, or null when unwatched. */
export async function getProgress(
  db: ProgressDb,
  userId: string,
  itemId: string,
) {
  await requireViewableItem(db, userId, itemId);
  return readProgress(db, userId, itemId);
}

/** Computes the resume position for a Version from stored compatible progress. */
export async function resumeProgress(
  db: ProgressDb,
  userId: string,
  itemId: string,
  versionId: string,
) {
  await requireViewableItem(db, userId, itemId);
  await requirePermission(db, userId, "play");
  const [version] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.itemId, itemId)))
    .limit(1);
  if (version === undefined) throw new AuthError("NOT_FOUND");
  return {
    positionSeconds: await resumePosition(db, userId, itemId, version),
  };
}

function checkScope(scope: Scope) {
  if (
    !Schema.is(Schema.UUID)(scope.sessionId) ||
    !Schema.is(Schema.UUID)(scope.itemId)
  )
    throw new AuthError("UNAUTHENTICATED");
}

function checkPosition(position: number, durationSeconds: number | null) {
  if (!Number.isFinite(position) || position < 0)
    throw new AuthError("INVALID_INPUT");
  if (durationSeconds !== null && position > durationSeconds)
    throw new AuthError("INVALID_INPUT");
}

async function lockSession(tx: LifecycleDb, userId: string, scope: Scope) {
  const [session] = await tx
    .select({
      userId: sessionRegistry.userId,
      versionId: sessionRegistry.versionId,
      state: sessionRegistry.state,
    })
    .from(sessionRegistry)
    .where(
      and(
        eq(sessionRegistry.id, scope.sessionId),
        eq(sessionRegistry.itemId, scope.itemId),
      ),
    )
    .for("update")
    .limit(1);
  if (session === undefined || session.userId !== userId)
    throw new AuthError("UNAUTHENTICATED");
  const [version] = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.id, session.versionId),
        eq(versions.itemId, scope.itemId),
      ),
    )
    .limit(1);
  if (version === undefined) throw new AuthError("NOT_FOUND");
  await requirePermission(tx, userId, "view", version.libraryId);
  await requirePermission(tx, userId, "play");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${scope.itemId}`}, 0))`,
  );
  return { session, version };
}

async function upsertProgress(
  tx: LifecycleDb,
  userId: string,
  itemId: string,
  version: VersionRow,
  positionSeconds: number,
  completed: boolean,
  countPlay: boolean,
) {
  await tx
    .insert(progress)
    .values({
      userId,
      itemId,
      versionId: version.id,
      format: version.format,
      positionSeconds,
      completed,
      playedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
      playCount: countPlay ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: [progress.userId, progress.itemId],
      set: {
        versionId: version.id,
        format: version.format,
        positionSeconds,
        completed,
        playedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        ...(countPlay ? { playCount: sql`${progress.playCount} + 1` } : {}),
      },
    });
}

async function touchSession(tx: LifecycleDb, sessionId: string) {
  await tx
    .update(sessionRegistry)
    .set({ lastSeenAt: sql`clock_timestamp()` })
    .where(eq(sessionRegistry.id, sessionId));
}

/** Marks a planned session playing and records its first position. */
export async function startPlayback(
  db: Database,
  userId: string,
  scope: Scope,
  positionSeconds?: number,
) {
  checkScope(scope);
  return db.transaction(async (tx) => {
    const { session, version } = await lockSession(tx, userId, scope);
    if (session.state === "playing")
      return {
        state: "playing" as const,
        progress: await readProgress(tx, userId, scope.itemId),
      };
    if (session.state !== "starting") throw new AuthError("CONFLICT");
    const position =
      positionSeconds ??
      (await resumePosition(tx, userId, scope.itemId, version));
    checkPosition(position, version.durationSeconds);
    await upsertProgress(
      tx,
      userId,
      scope.itemId,
      version,
      position,
      false,
      true,
    );
    await tx
      .update(sessionRegistry)
      .set({ state: "playing", lastSeenAt: sql`clock_timestamp()` })
      .where(eq(sessionRegistry.id, scope.sessionId));
    await publishEvent(tx, {
      kind: "session.state",
      sessionId: scope.sessionId,
      state: "playing",
    });
    return {
      state: "playing" as const,
      progress: await readProgress(tx, userId, scope.itemId),
    };
  });
}

/** Records a position heartbeat for a playing session. */
export async function updatePlayback(
  db: Database,
  userId: string,
  scope: Scope,
  input: { positionSeconds: number; completed?: boolean },
) {
  checkScope(scope);
  return db.transaction(async (tx) => {
    const { session, version } = await lockSession(tx, userId, scope);
    if (session.state !== "playing") throw new AuthError("CONFLICT");
    checkPosition(input.positionSeconds, version.durationSeconds);
    await upsertProgress(
      tx,
      userId,
      scope.itemId,
      version,
      input.positionSeconds,
      input.completed ?? false,
      false,
    );
    await touchSession(tx, scope.sessionId);
    return {
      state: "playing" as const,
      progress: await readProgress(tx, userId, scope.itemId),
    };
  });
}

/** Stops a session, persisting the final position when it was playing. */
export async function stopPlayback(
  db: Database,
  userId: string,
  scope: Scope,
  input: { positionSeconds: number; completed?: boolean },
) {
  checkScope(scope);
  return db.transaction(async (tx) => {
    const { session, version } = await lockSession(tx, userId, scope);
    if (session.state === "stopped")
      return {
        state: "stopped" as const,
        progress: await readProgress(tx, userId, scope.itemId),
      };
    if (session.state === "queued") throw new AuthError("CONFLICT");
    if (session.state === "playing") {
      checkPosition(input.positionSeconds, version.durationSeconds);
      await upsertProgress(
        tx,
        userId,
        scope.itemId,
        version,
        input.positionSeconds,
        input.completed ?? false,
        false,
      );
    }
    await tx
      .update(sessionRegistry)
      .set({ state: "stopped", lastSeenAt: sql`clock_timestamp()` })
      .where(eq(sessionRegistry.id, scope.sessionId));
    await publishEvent(tx, {
      kind: "session.state",
      sessionId: scope.sessionId,
      state: "stopped",
    });
    return {
      state: "stopped" as const,
      progress: await readProgress(tx, userId, scope.itemId),
    };
  });
}
