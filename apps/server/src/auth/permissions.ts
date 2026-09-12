import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  groups,
  libraryAccess,
  type Permission,
  permissions,
  userGroups,
  userPermissionOverrides,
  users,
} from "../db/schema/index.ts";
import { AuthError } from "./errors.ts";

function postgresCode(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>;
    if (typeof record.errno === "string") return record.errno;
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

type Queryable = Pick<Database, "select">;

async function enabledUser(
  db: Queryable,
  userId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  return row;
}

async function memberships(db: Database, userId: string) {
  return db
    .select({
      id: groups.id,
      name: groups.name,
      builtIn: groups.builtIn,
      permissions: groups.permissions,
    })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(eq(userGroups.userId, userId));
}

/** Reports whether an enabled user holds a permission via groups, overrides or library access. */
export async function checkPermission(
  db: Database,
  userId: string,
  permission: Permission,
  libraryId?: string,
): Promise<boolean> {
  if (!(await enabledUser(db, userId))) return false;
  const memberGroups = await memberships(db, userId);
  if (memberGroups.some((g) => g.builtIn && g.name === "admins")) return true;

  let granted = memberGroups.some((g) => g.permissions.includes(permission));
  const [override] = await db
    .select({ allowed: userPermissionOverrides.allowed })
    .from(userPermissionOverrides)
    .where(
      and(
        eq(userPermissionOverrides.userId, userId),
        eq(userPermissionOverrides.permission, permission),
      ),
    )
    .limit(1);
  if (override) granted = override.allowed;

  if (permission === "view" && libraryId) {
    const groupIds = memberGroups.map((g) => g.id);
    const access = await db
      .select({ allowed: libraryAccess.allowed })
      .from(libraryAccess)
      .where(
        and(
          eq(libraryAccess.libraryId, libraryId),
          or(
            eq(libraryAccess.userId, userId),
            groupIds.length
              ? inArray(libraryAccess.groupId, groupIds)
              : undefined,
          ),
        ),
      );
    if (access.length) return access.every((row) => row.allowed);
  }
  return granted;
}

/** Throws FORBIDDEN when an enabled user lacks a permission. */
export async function requirePermission(
  db: Database,
  userId: string,
  permission: Permission,
  libraryId?: string,
): Promise<void> {
  if (!(await checkPermission(db, userId, permission, libraryId)))
    throw new AuthError("FORBIDDEN");
}

const builtInNames = ["admins", "users"];

/** Creates a custom permission group; the actor needs manage-users. */
export async function createGroup(
  db: Database,
  actorId: string,
  input: { name: string; permissions: Permission[] },
) {
  await requirePermission(db, actorId, "manage-users");
  const name = input.name.trim();
  if (
    !name ||
    name.length > 80 ||
    builtInNames.includes(name.toLowerCase()) ||
    input.permissions.some(
      (p) => !(permissions as readonly string[]).includes(p),
    )
  )
    throw new AuthError("INVALID_INPUT");
  const unique = [...new Set(input.permissions)];
  try {
    const [group] = await db
      .insert(groups)
      .values({ name, builtIn: false, permissions: unique })
      .returning();
    if (!group) throw new Error("Group insert returned no row.");
    return group;
  } catch (error) {
    if (postgresCode(error) === "23505") throw new AuthError("CONFLICT");
    throw error;
  }
}

/** Replaces a user's group memberships; the actor needs manage-users. */
export async function setUserGroups(
  db: Database,
  actorId: string,
  userId: string,
  groupIds: string[],
): Promise<void> {
  await requirePermission(db, actorId, "manage-users");
  const unique = [...new Set(groupIds)];
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)))
      .for("update");
    if (!target) throw new AuthError("NOT_FOUND");
    if (unique.length) {
      const found = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(inArray(groups.id, unique));
      if (found.length !== unique.length) throw new AuthError("NOT_FOUND");
    }
    await tx.delete(userGroups).where(eq(userGroups.userId, userId));
    if (unique.length)
      await tx
        .insert(userGroups)
        .values(unique.map((groupId) => ({ userId, groupId })));
  });
}

/** Sets or clears a per-user permission override; the actor needs manage-users. */
export async function setPermissionOverride(
  db: Database,
  actorId: string,
  userId: string,
  permission: Permission,
  allowed: boolean | null,
): Promise<void> {
  await requirePermission(db, actorId, "manage-users");
  if (!(permissions as readonly string[]).includes(permission))
    throw new AuthError("INVALID_INPUT");
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) throw new AuthError("NOT_FOUND");
  const where = and(
    eq(userPermissionOverrides.userId, userId),
    eq(userPermissionOverrides.permission, permission),
  );
  if (allowed === null) {
    await db.delete(userPermissionOverrides).where(where);
  } else {
    await db
      .insert(userPermissionOverrides)
      .values({ userId, permission, allowed })
      .onConflictDoUpdate({
        target: [
          userPermissionOverrides.userId,
          userPermissionOverrides.permission,
        ],
        set: { allowed },
      });
  }
}
