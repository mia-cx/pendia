import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  groups,
  libraries,
  libraryAccess,
  type Permission,
  permissions,
  userGroups,
  userPermissionOverrides,
  userSettings,
  users,
} from "../db/schema/index.ts";
import { AuthError } from "./errors.ts";
import { requireAdmin, requirePermission } from "./permissions.ts";

const userFields = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  email: users.email,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
};

const groupFields = {
  id: groups.id,
  name: groups.name,
  builtIn: groups.builtIn,
  permissions: groups.permissions,
};

/** Lists every user for a caller holding manage-users. */
export async function listUsers(db: Database, actorId: string) {
  await requirePermission(db, actorId, "manage-users");
  return db.select(userFields).from(users).orderBy(asc(users.username));
}

/** Lists every group for a caller holding manage-users. */
export async function listGroups(db: Database, actorId: string) {
  await requirePermission(db, actorId, "manage-users");
  return db.select(groupFields).from(groups).orderBy(asc(groups.name));
}

/** Loads one user's groups, overrides, library access and settings without a caller check. */
export async function readUserAccess(db: Database, userId: string) {
  const [user] = await db
    .select(userFields)
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new AuthError("NOT_FOUND");
  const membershipRows = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId))
    .orderBy(asc(userGroups.groupId));
  const overrides = await db
    .select({
      permission: userPermissionOverrides.permission,
      allowed: userPermissionOverrides.allowed,
    })
    .from(userPermissionOverrides)
    .where(eq(userPermissionOverrides.userId, userId))
    .orderBy(asc(userPermissionOverrides.permission));
  const access = await db
    .select({
      libraryId: libraryAccess.libraryId,
      allowed: libraryAccess.allowed,
    })
    .from(libraryAccess)
    .where(eq(libraryAccess.userId, userId))
    .orderBy(asc(libraryAccess.libraryId));
  const [stored] = await db
    .select({
      bitrateCapBps: userSettings.bitrateCapBps,
      contentRatingCeiling: userSettings.contentRatingCeiling,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return {
    user,
    groupIds: membershipRows.map((row) => row.groupId),
    overrides,
    libraryAccess: access,
    settings: stored ?? { bitrateCapBps: null, contentRatingCeiling: null },
  };
}

/** Loads one user's full access shape for a caller holding manage-users. */
export async function getUserAccess(
  db: Database,
  actorId: string,
  userId: string,
) {
  await requirePermission(db, actorId, "manage-users");
  return readUserAccess(db, userId);
}

/** Replaces a custom group's permissions; the actor must be a built-in admin. */
export async function setGroupPermissions(
  db: Database,
  actorId: string,
  groupId: string,
  input: readonly Permission[],
) {
  await requireAdmin(db, actorId);
  const [group] = await db
    .select(groupFields)
    .from(groups)
    .where(eq(groups.id, groupId));
  if (!group) throw new AuthError("NOT_FOUND");
  if (group.builtIn) throw new AuthError("INVALID_INPUT");
  if (
    input.some(
      (permission) => !(permissions as readonly string[]).includes(permission),
    )
  )
    throw new AuthError("INVALID_INPUT");
  const [updated] = await db
    .update(groups)
    .set({ permissions: [...new Set(input)] })
    .where(eq(groups.id, groupId))
    .returning(groupFields);
  if (!updated) throw new Error("Group update returned no row.");
  return updated;
}

/** Writes a user's bitrate cap and content-rating ceiling for a caller holding manage-users. */
export async function writeUserSettings(
  db: Database,
  actorId: string,
  userId: string,
  input: { bitrateCapBps: bigint | null; contentRatingCeiling: string | null },
) {
  await requirePermission(db, actorId, "manage-users");
  if (input.bitrateCapBps !== null && input.bitrateCapBps <= 0n)
    throw new AuthError("INVALID_INPUT");
  let contentRatingCeiling: string | null = null;
  if (input.contentRatingCeiling !== null) {
    const trimmed = input.contentRatingCeiling.trim();
    if (trimmed.length === 0 || trimmed.length > 64)
      throw new AuthError("INVALID_INPUT");
    contentRatingCeiling = trimmed;
  }
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  if (!target) throw new AuthError("NOT_FOUND");
  const [stored] = await db
    .insert(userSettings)
    .values({
      userId,
      bitrateCapBps: input.bitrateCapBps,
      contentRatingCeiling,
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        bitrateCapBps: input.bitrateCapBps,
        contentRatingCeiling,
      },
    })
    .returning({
      bitrateCapBps: userSettings.bitrateCapBps,
      contentRatingCeiling: userSettings.contentRatingCeiling,
    });
  if (!stored) throw new Error("User settings upsert returned no row.");
  return stored;
}

/** Sets or clears one user or group access row on a library; the actor must be a built-in admin. */
export async function setLibraryAccess(
  db: Database,
  actorId: string,
  input: {
    libraryId: string;
    userId?: string;
    groupId?: string;
    allowed: boolean | null;
  },
): Promise<void> {
  await requireAdmin(db, actorId);
  const userId = input.userId;
  const groupId = input.groupId;
  if ((userId === undefined) === (groupId === undefined))
    throw new AuthError("INVALID_INPUT");
  await db.transaction(async (tx) => {
    const [library] = await tx
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, input.libraryId));
    if (!library) throw new AuthError("NOT_FOUND");
    if (userId !== undefined) {
      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId));
      if (!target) throw new AuthError("NOT_FOUND");
      await tx
        .delete(libraryAccess)
        .where(
          and(
            eq(libraryAccess.libraryId, input.libraryId),
            eq(libraryAccess.userId, userId),
          ),
        );
      if (input.allowed !== null)
        await tx.insert(libraryAccess).values({
          libraryId: input.libraryId,
          userId,
          allowed: input.allowed,
        });
    } else if (groupId !== undefined) {
      const [target] = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.id, groupId));
      if (!target) throw new AuthError("NOT_FOUND");
      await tx
        .delete(libraryAccess)
        .where(
          and(
            eq(libraryAccess.libraryId, input.libraryId),
            eq(libraryAccess.groupId, groupId),
          ),
        );
      if (input.allowed !== null)
        await tx.insert(libraryAccess).values({
          libraryId: input.libraryId,
          groupId,
          allowed: input.allowed,
        });
    }
  });
}
