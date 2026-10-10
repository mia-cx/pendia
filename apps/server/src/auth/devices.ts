import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { sessions, users } from "../db/schema/index.ts";
import { AuthError } from "./errors.ts";
import { isBuiltInAdmin, requireAdmin } from "./permissions.ts";
import { readAuthSettings } from "./settings.ts";

/** Lists live device sessions, scoped to the caller unless the caller is an administrator. */
export async function activeSessions(db: Database, actorId: string) {
  const [admin, config] = await Promise.all([
    isBuiltInAdmin(db, actorId),
    readAuthSettings(db),
  ]);
  return db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      username: users.username,
      clientName: sessions.clientName,
      deviceId: sessions.deviceId,
      deviceName: sessions.deviceName,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        admin ? undefined : eq(sessions.userId, actorId),
        isNull(sessions.revokedAt),
        isNull(users.disabledAt),
        or(
          isNull(sessions.expiresAt),
          gt(sessions.expiresAt, sql`statement_timestamp()`),
        ),
        config.sessionMaxAgeSeconds === null
          ? undefined
          : sql`${sessions.createdAt} > statement_timestamp() - ${config.sessionMaxAgeSeconds} * interval '1 second'`,
      ),
    )
    .orderBy(desc(sessions.lastSeenAt), desc(sessions.id));
}

/** Updates a device's recorded name or revokes all its sessions, as an administrator. */
export async function updateDevice(
  db: Database,
  actorId: string,
  deviceId: string,
  input: { name?: string; revoke?: boolean },
) {
  await requireAdmin(db, actorId);
  if (
    input.name !== undefined &&
    (input.name.trim().length < 1 || input.name.length > 128)
  )
    throw new AuthError("INVALID_INPUT");
  const updated = await db
    .update(sessions)
    .set({
      ...(input.name === undefined ? {} : { deviceName: input.name.trim() }),
      ...(input.revoke ? { revokedAt: new Date() } : {}),
    })
    .where(eq(sessions.deviceId, deviceId))
    .returning({ id: sessions.id });
  if (updated.length === 0) throw new AuthError("NOT_FOUND");
}
