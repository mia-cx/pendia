import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { groups, settings, userGroups, users } from "../db/schema/index.ts";
import { AuthError, postgresCode } from "./errors.ts";
import { requirePermission } from "./permissions.ts";

type LocalAccountInput = {
  username: string;
  password: string;
  displayName?: string;
};

/** The safe public column selection shared by auth account functions. */
export const publicUserFields = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
};

const usernamePattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const setupCompleteKey = "auth.setupComplete";
const setupLockKey = 0x70656e646175n;

/** Validates and hashes a local account before its transaction starts. */
export async function prepareLocalAccount(input: LocalAccountInput) {
  const username = input.username.trim().toLowerCase();
  const displayName = (input.displayName ?? username).trim();
  if (
    !usernamePattern.test(username) ||
    input.password.length < 1 ||
    input.password.length > 1024 ||
    displayName.length < 1 ||
    displayName.length > 128
  )
    throw new AuthError("INVALID_INPUT");
  const passwordHash = await Bun.password.hash(input.password, {
    algorithm: "argon2id",
  });
  return { username, displayName, passwordHash };
}

async function setupClosed(db: Pick<Database, "select">): Promise<boolean> {
  const [marker] = await db
    .select({ id: settings.id })
    .from(settings)
    .where(eq(settings.key, setupCompleteKey))
    .limit(1);
  if (marker) return true;
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  return !!existing;
}

/** Reports whether the first admin already exists, so the wizard knows setup is closed. */
export async function isSetupComplete(db: Database) {
  return setupClosed(db);
}

async function seedGroup(db: Pick<Database, "select">, name: string) {
  const [group] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.name, name), eq(groups.builtIn, true)))
    .limit(1);
  if (!group)
    throw new Error(`Seeded ${name} group missing; run migrations first.`);
  return group;
}

/** Creates the first admin exactly once under a setup advisory lock. */
export async function setupAdmin(db: Database, input: LocalAccountInput) {
  if (await setupClosed(db)) throw new AuthError("SETUP_COMPLETE");
  const prepared = await prepareLocalAccount(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${setupLockKey})`);
    if (await setupClosed(tx)) throw new AuthError("SETUP_COMPLETE");
    const admins = await seedGroup(tx, "admins");
    const [user] = await tx
      .insert(users)
      .values(prepared)
      .returning(publicUserFields);
    if (!user) throw new Error("Admin insert returned no row.");
    await tx.insert(userGroups).values({ userId: user.id, groupId: admins.id });
    await tx.insert(settings).values({
      key: setupCompleteKey,
      value: sql`'true'::jsonb`,
    });
    return user;
  });
}

/** Creates a local user in the seeded users group; the actor needs manage-users. */
export async function createLocalUser(
  db: Database,
  actorId: string,
  input: LocalAccountInput,
) {
  await requirePermission(db, actorId, "manage-users");
  const prepared = await prepareLocalAccount(input);
  try {
    return await db.transaction(async (tx) => {
      const members = await seedGroup(tx, "users");
      const [user] = await tx
        .insert(users)
        .values(prepared)
        .returning(publicUserFields);
      if (!user) throw new Error("User insert returned no row.");
      await tx
        .insert(userGroups)
        .values({ userId: user.id, groupId: members.id });
      return user;
    });
  } catch (error) {
    if (postgresCode(error) === "23505") throw new AuthError("CONFLICT");
    throw error;
  }
}
