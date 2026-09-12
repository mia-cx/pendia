import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { apiKeys, sessions, users } from "../db/schema/index.ts";
import { publicUserFields } from "./accounts.ts";
import { AuthError } from "./errors.ts";
import { requirePermission } from "./permissions.ts";
import { consumeLoginAttempt } from "./rate-limit.ts";
import { readAuthSettings } from "./settings.ts";

type DeviceInput = {
  clientName: string;
  deviceId: string;
  deviceName: string;
};

type LoginInput = {
  username: string;
  password: string;
  clientName: string;
  deviceId: string;
  deviceName: string;
};

type SessionTransaction = Pick<Database, "select" | "insert">;

const usernamePattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const safeSessionFields = {
  id: sessions.id,
  userId: sessions.userId,
  clientName: sessions.clientName,
  deviceId: sessions.deviceId,
  deviceName: sessions.deviceName,
  createdAt: sessions.createdAt,
  lastSeenAt: sessions.lastSeenAt,
  expiresAt: sessions.expiresAt,
  revokedAt: sessions.revokedAt,
};

const safeApiKeyFields = {
  id: apiKeys.id,
  userId: apiKeys.userId,
  name: apiKeys.name,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
};

function newToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest();
}

function prepareDevice(input: DeviceInput) {
  const clientName = input.clientName.trim();
  const deviceName = input.deviceName.trim();
  if (
    clientName.length < 1 ||
    clientName.length > 128 ||
    deviceName.length < 1 ||
    deviceName.length > 128 ||
    input.deviceId.length < 1 ||
    input.deviceId.length > 128
  )
    throw new AuthError("INVALID_INPUT");
  return { clientName, deviceId: input.deviceId, deviceName };
}

let dummyHash: Promise<string> | undefined;

async function verifyPassword(password: string, stored: string | null) {
  dummyHash ??= Bun.password.hash(randomBytes(32).toString("hex"), {
    algorithm: "argon2id",
  });
  const hash = stored ?? (await dummyHash);
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

async function enabledUserById(db: Pick<Database, "select">, userId: string) {
  const [user] = await db
    .select(publicUserFields)
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  return user;
}

async function ownOrManager(
  db: Database,
  actorId: string,
  userId: string,
): Promise<void> {
  if (!(await enabledUserById(db, actorId))) throw new AuthError("FORBIDDEN");
  if (userId !== actorId) await requirePermission(db, actorId, "manage-users");
}

/** Issues a device session inside the caller's database transaction. */
export async function issueSession(
  db: SessionTransaction,
  userId: string,
  input: DeviceInput,
  maxAgeSeconds: number | null,
) {
  const device = prepareDevice(input);
  const token = newToken();
  const [enabled] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .for("update");
  if (!enabled) throw new AuthError("INVALID_CREDENTIALS");
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      clientName: device.clientName,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      expiresAt:
        maxAgeSeconds === null
          ? null
          : sql`clock_timestamp() + ${maxAgeSeconds} * interval '1 second'`,
    })
    .returning(safeSessionFields);
  if (!session) throw new Error("Session insert returned no row.");
  const user = await enabledUserById(db, userId);
  if (!user) throw new AuthError("INVALID_CREDENTIALS");
  return { token, user, session };
}

/** Logs in a local user and returns a new device session with its opaque token. */
export async function login(db: Database, input: LoginInput, address: string) {
  const username = input.username.trim().toLowerCase();
  prepareDevice(input);
  if (
    !usernamePattern.test(username) ||
    input.password.length < 1 ||
    input.password.length > 1024
  )
    throw new AuthError("INVALID_INPUT");

  const config = await readAuthSettings(db);
  await consumeLoginAttempt(db, address, username, config);

  const [found] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${username}`)
    .limit(1);
  const verified = await verifyPassword(
    input.password,
    found?.passwordHash ?? null,
  );
  if (!found || found.disabledAt || !verified)
    throw new AuthError("INVALID_CREDENTIALS");

  return db.transaction((tx) =>
    issueSession(tx, found.id, input, config.sessionMaxAgeSeconds),
  );
}

const enabledOwner = (userId: unknown) =>
  sql`exists (select 1 from ${users} where ${users.id} = ${userId} and ${users.disabledAt} is null)`;

/** Authenticates an opaque bearer token against live session and API key rows. */
export async function authenticate(db: Database, token: string) {
  if (!tokenPattern.test(token)) throw new AuthError("UNAUTHENTICATED");
  const config = await readAuthSettings(db);
  const digest = hashToken(token);

  const [session] = await db
    .update(sessions)
    .set({ lastSeenAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(sessions.tokenHash, digest),
        isNull(sessions.revokedAt),
        or(
          isNull(sessions.expiresAt),
          gt(sessions.expiresAt, sql`statement_timestamp()`),
        ),
        config.sessionMaxAgeSeconds === null
          ? undefined
          : sql`${sessions.createdAt} > statement_timestamp() - ${config.sessionMaxAgeSeconds} * interval '1 second'`,
        enabledOwner(sessions.userId),
      ),
    )
    .returning(safeSessionFields);
  if (session) {
    const user = await enabledUserById(db, session.userId);
    if (!user) throw new AuthError("UNAUTHENTICATED");
    return { user, credential: { kind: "session" as const, id: session.id } };
  }

  const [key] = await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(apiKeys.tokenHash, digest),
        isNull(apiKeys.revokedAt),
        or(
          isNull(apiKeys.expiresAt),
          gt(apiKeys.expiresAt, sql`statement_timestamp()`),
        ),
        enabledOwner(apiKeys.userId),
      ),
    )
    .returning(safeApiKeyFields);
  if (key) {
    const user = await enabledUserById(db, key.userId);
    if (!user) throw new AuthError("UNAUTHENTICATED");
    return { user, credential: { kind: "api-key" as const, id: key.id } };
  }

  throw new AuthError("UNAUTHENTICATED");
}

/** Lists a user's sessions newest first; allowed for the owner or manage-users. */
export async function listSessions(
  db: Database,
  actorId: string,
  userId = actorId,
) {
  await ownOrManager(db, actorId, userId);
  return db
    .select(safeSessionFields)
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt));
}

/** Revokes a session by id; allowed for the owner or manage-users. */
export async function revokeSession(
  db: Database,
  actorId: string,
  sessionId: string,
): Promise<void> {
  const [session] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) throw new AuthError("NOT_FOUND");
  await ownOrManager(db, actorId, session.userId);
  await db
    .update(sessions)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Creates a labeled API key for the actor and returns its token once. */
export async function createApiKey(
  db: Database,
  actorId: string,
  name: string,
) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 128)
    throw new AuthError("INVALID_INPUT");
  if (!(await enabledUserById(db, actorId))) throw new AuthError("FORBIDDEN");
  const token = newToken();
  const [key] = await db
    .insert(apiKeys)
    .values({ userId: actorId, name: trimmed, tokenHash: hashToken(token) })
    .returning(safeApiKeyFields);
  if (!key) throw new Error("API key insert returned no row.");
  return { token, key };
}

/** Lists a user's API keys newest first; allowed for the owner or manage-users. */
export async function listApiKeys(
  db: Database,
  actorId: string,
  userId = actorId,
) {
  await ownOrManager(db, actorId, userId);
  return db
    .select(safeApiKeyFields)
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

/** Revokes an API key by id; allowed for the owner or manage-users. */
export async function revokeApiKey(
  db: Database,
  actorId: string,
  keyId: string,
): Promise<void> {
  const [key] = await db
    .select({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  if (!key) throw new AuthError("NOT_FOUND");
  await ownOrManager(db, actorId, key.userId);
  await db
    .update(apiKeys)
    .set({ revokedAt: sql`clock_timestamp()` })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)));
}
