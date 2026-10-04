import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { quickConnectRequests } from "../db/schema/index.ts";
import { AuthError, postgresCode } from "./errors.ts";
import { issueSession, prepareDevice } from "./sessions.ts";
import { readAuthSettings } from "./settings.ts";

// How long a device may wait for approval. Jellyfin also allows 10 minutes.
const quickConnectLifetimeSeconds = 600;

const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const codeAttempts = 5;
const maxVersionLength = 128;

const hashSecret = (secret: string) =>
  createHash("sha256").update(secret).digest();

const live = sql`${quickConnectRequests.expiresAt} > statement_timestamp()`;

const requestFields = {
  code: quickConnectRequests.code,
  clientName: quickConnectRequests.clientName,
  clientVersion: quickConnectRequests.clientVersion,
  deviceId: quickConnectRequests.deviceId,
  deviceName: quickConnectRequests.deviceName,
  createdAt: quickConnectRequests.createdAt,
  authorized: sql<boolean>`${quickConnectRequests.userId} is not null`,
};

/** Starts a Quick Connect login. The device shows the code and polls with the secret. */
export async function initiateQuickConnect(
  db: Database,
  input: {
    clientName: string;
    clientVersion: string;
    deviceId: string;
    deviceName: string;
  },
) {
  const device = prepareDevice(input);
  if (input.clientVersion.length > maxVersionLength)
    throw new AuthError("INVALID_INPUT");
  await db
    .delete(quickConnectRequests)
    .where(lt(quickConnectRequests.expiresAt, sql`statement_timestamp()`));
  // Six digits can collide with another pending code, so a clash draws again.
  for (let attempt = 1; ; attempt++) {
    const secret = randomBytes(32).toString("base64url");
    try {
      const [request] = await db
        .insert(quickConnectRequests)
        .values({
          ...device,
          clientVersion: input.clientVersion,
          secretHash: hashSecret(secret),
          code: String(randomInt(1_000_000)).padStart(6, "0"),
          expiresAt: sql`clock_timestamp() + ${quickConnectLifetimeSeconds} * interval '1 second'`,
        })
        .returning(requestFields);
      if (!request) throw new Error("Quick Connect insert returned no row.");
      return { secret, request };
    } catch (error) {
      if (postgresCode(error) !== "23505" || attempt === codeAttempts)
        throw error;
    }
  }
}

/** Reads a pending request by its secret, so the waiting device learns when it is approved. */
export async function quickConnectState(db: Database, secret: string) {
  if (!secretPattern.test(secret)) throw new AuthError("NOT_FOUND");
  const [request] = await db
    .select(requestFields)
    .from(quickConnectRequests)
    .where(and(eq(quickConnectRequests.secretHash, hashSecret(secret)), live))
    .limit(1);
  if (!request) throw new AuthError("NOT_FOUND");
  return request;
}

/** Approves a pending code for the signed-in user. */
export async function authorizeQuickConnect(
  db: Database,
  userId: string,
  code: string,
): Promise<void> {
  const [approved] = await db
    .update(quickConnectRequests)
    .set({ userId })
    .where(
      and(
        eq(quickConnectRequests.code, code),
        isNull(quickConnectRequests.userId),
        live,
      ),
    )
    .returning({ id: quickConnectRequests.id });
  if (!approved) throw new AuthError("NOT_FOUND");
}

/** Trades an approved secret for a device session, exactly once. */
export async function authenticateWithQuickConnect(
  db: Database,
  secret: string,
) {
  if (!secretPattern.test(secret)) throw new AuthError("INVALID_CREDENTIALS");
  const config = await readAuthSettings(db);
  return db.transaction(async (tx) => {
    const [request] = await tx
      .delete(quickConnectRequests)
      .where(
        and(
          eq(quickConnectRequests.secretHash, hashSecret(secret)),
          isNotNull(quickConnectRequests.userId),
          live,
        ),
      )
      .returning();
    if (!request?.userId) throw new AuthError("INVALID_CREDENTIALS");
    return issueSession(
      tx,
      request.userId,
      request,
      config.sessionMaxAgeSeconds,
    );
  });
}
