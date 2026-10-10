import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { JsonValue } from "../db/schema/common.ts";
import { groups, settings, userGroups, users } from "../db/schema/index.ts";
import { publicUserFields } from "./accounts.ts";
import { AuthError, postgresCode } from "./errors.ts";
import { requireAdmin } from "./permissions.ts";

/** Authorizes account and preference access for the owner or a built-in administrator. */
export async function requireAccountAccess(
  db: Database,
  actorId: string,
  userId: string,
) {
  if (actorId !== userId) await requireAdmin(db, actorId);
}

/** Reads account identity and password/disabled state without exposing its password hash. */
export async function readAccount(
  db: Database,
  actorId: string,
  userId: string,
) {
  await requireAccountAccess(db, actorId, userId);
  const [user] = await db
    .select({
      ...publicUserFields,
      disabledAt: users.disabledAt,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (user === undefined) throw new AuthError("NOT_FOUND");
  const { passwordHash, ...identity } = user;
  return {
    ...identity,
    hasPassword:
      passwordHash !== null && !(await Bun.password.verify("", passwordHash)),
  };
}

/** Reads an opaque client preference under its user's namespace. */
export async function readClientPreference(
  db: Database,
  actorId: string,
  userId: string,
  client: string,
  id: string,
): Promise<JsonValue | undefined> {
  await requireAccountAccess(db, actorId, userId);
  const key = preferenceKey(userId, client, id);
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  return row?.value;
}

function preferenceKey(userId: string, client: string, id: string) {
  return `client.preferences.${userId}.${encodeURIComponent(client)}.${encodeURIComponent(id)}`;
}

/** Replaces one opaque client preference; adapters own the payload format. */
export async function writeClientPreference(
  db: Database,
  actorId: string,
  userId: string,
  client: string,
  id: string,
  value: JsonValue,
) {
  await requireAccountAccess(db, actorId, userId);
  const key = preferenceKey(userId, client, id);
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** Renames an account for its owner or an administrator. */
export async function renameAccount(
  db: Database,
  actorId: string,
  userId: string,
  name: string,
) {
  await requireAccountAccess(db, actorId, userId);
  const username = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(username))
    throw new AuthError("INVALID_INPUT");
  try {
    const [updated] = await db
      .update(users)
      .set({ username, displayName: name.trim(), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning(publicUserFields);
    if (updated === undefined) throw new AuthError("NOT_FOUND");
    return updated;
  } catch (error) {
    if (postgresCode(error) === "23505") throw new AuthError("CONFLICT");
    throw error;
  }
}

/** Changes a local password. Owners prove the current password; administrators can reset it. */
export async function changePassword(
  db: Database,
  actorId: string,
  userId: string,
  password: string,
  currentPassword?: string,
) {
  await requireAccountAccess(db, actorId, userId);
  if (password.length > 1024) throw new AuthError("INVALID_INPUT");
  const [target] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId));
  if (target === undefined) throw new AuthError("NOT_FOUND");
  if (currentPassword === undefined) await requireAdmin(db, actorId);
  else if (
    target.passwordHash === null ||
    !(await Bun.password.verify(currentPassword, target.passwordHash))
  )
    throw new AuthError("INVALID_CREDENTIALS");
  const passwordHash = await Bun.password.hash(password, {
    algorithm: "argon2id",
  });
  const [updated] = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(
      and(
        eq(users.id, userId),
        target.passwordHash === null
          ? isNull(users.passwordHash)
          : eq(users.passwordHash, target.passwordHash),
      ),
    )
    .returning({ id: users.id });
  if (updated === undefined) throw new AuthError("CONFLICT");
}

/** Deletes or disables an account, preserving an enabled administrator under the group lock. */
export async function removeAccount(
  db: Database,
  actorId: string,
  userId: string,
  disabled?: boolean,
) {
  await requireAdmin(db, actorId);
  await db.transaction(async (tx) => {
    const [adminGroup] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.name, "admins"), eq(groups.builtIn, true)))
      .for("update");
    if (adminGroup === undefined)
      throw new Error("Seeded admins group missing.");
    await requireAdmin(tx, actorId);
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (target === undefined) throw new AuthError("NOT_FOUND");
    const [membership] = await tx
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(
        and(
          eq(userGroups.userId, userId),
          eq(userGroups.groupId, adminGroup.id),
        ),
      );
    if (membership !== undefined && disabled !== false) {
      const [other] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(userGroups, eq(userGroups.userId, users.id))
        .where(
          and(
            eq(userGroups.groupId, adminGroup.id),
            ne(users.id, userId),
            isNull(users.disabledAt),
          ),
        )
        .limit(1);
      if (other === undefined) throw new AuthError("CONFLICT");
    }
    if (disabled === undefined) {
      await tx
        .delete(settings)
        .where(sql`${settings.key} like ${`client.preferences.${userId}.%`}`);
      await tx.delete(users).where(eq(users.id, userId));
      return;
    }
    await tx
      .update(users)
      .set({ disabledAt: disabled ? new Date() : null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  });
}
