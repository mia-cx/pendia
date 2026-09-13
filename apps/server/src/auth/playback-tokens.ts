import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Schema } from "effect";
import type { Database } from "../db/client.ts";
import {
  apiKeys,
  items,
  sessionRegistry,
  sessions,
  settings,
  users,
} from "../db/schema/index.ts";
import { AuthError } from "./errors.ts";
import { requirePermission } from "./permissions.ts";
import type { authenticate } from "./sessions.ts";
import { readAuthSettings } from "./settings.ts";

/** The lifetime, in seconds, of a signed playback token. */
export const playbackTokenLifetimeSeconds = 300;

type PlaybackScope = { sessionId: string; itemId: string };
type PlaybackCaller = Awaited<ReturnType<typeof authenticate>>;

const Claims = Schema.Struct({
  v: Schema.Literal(1),
  sessionId: Schema.UUID,
  itemId: Schema.UUID,
  userId: Schema.UUID,
  credential: Schema.Struct({
    kind: Schema.Literal("session", "api-key"),
    id: Schema.UUID,
  }),
  exp: Schema.Number.pipe(Schema.int(), Schema.positive()),
});
type Claims = typeof Claims.Type;

const signingKeySetting = "auth.playbackSigningKey";
const maxTokenLength = 2048;
const signatureByteLength = 32;
const encodedKeyLength = 43;

function unauthenticated(): never {
  throw new AuthError("UNAUTHENTICATED");
}

async function readSigningKey(db: Database) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, signingKeySetting))
    .limit(1);
  return row?.value;
}

async function signingKey(db: Database) {
  let value = await readSigningKey(db);
  if (value === undefined) {
    await db
      .insert(settings)
      .values({
        key: signingKeySetting,
        value: randomBytes(signatureByteLength).toString("base64url"),
      })
      .onConflictDoNothing({ target: settings.key });
    value = await readSigningKey(db);
  }
  if (typeof value !== "string")
    throw new Error("Invalid playback signing key.");
  const key = Buffer.from(value, "base64url");
  if (
    value.length !== encodedKeyLength ||
    key.length !== signatureByteLength ||
    key.toString("base64url") !== value
  )
    throw new Error("Invalid playback signing key.");
  return key;
}

async function liveSession(db: Database, scope: PlaybackScope) {
  if (
    !Schema.is(Schema.UUID)(scope.sessionId) ||
    !Schema.is(Schema.UUID)(scope.itemId)
  )
    unauthenticated();
  const [row] = await db
    .select({
      userId: sessionRegistry.userId,
      itemId: sessionRegistry.itemId,
      state: sessionRegistry.state,
      libraryId: items.libraryId,
    })
    .from(sessionRegistry)
    .innerJoin(items, eq(items.id, sessionRegistry.itemId))
    .where(
      and(
        eq(sessionRegistry.id, scope.sessionId),
        eq(sessionRegistry.itemId, scope.itemId),
      ),
    )
    .limit(1);
  if (!row || row.state === "stopped") unauthenticated();
  return row;
}

async function enabledOwner(db: Database, userId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  if (!row) unauthenticated();
}

async function liveCredential(
  db: Database,
  userId: string,
  credential: Claims["credential"],
) {
  if (!Schema.is(Schema.UUID)(credential.id)) unauthenticated();
  const config = await readAuthSettings(db);
  if (credential.kind === "session") {
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, credential.id),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          or(
            isNull(sessions.expiresAt),
            gt(sessions.expiresAt, sql`statement_timestamp()`),
          ),
          config.sessionMaxAgeSeconds === null
            ? undefined
            : sql`${sessions.createdAt} > statement_timestamp() - ${config.sessionMaxAgeSeconds} * interval '1 second'`,
        ),
      )
      .limit(1);
    if (!row) unauthenticated();
    return;
  }
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, credential.id),
        eq(apiKeys.userId, userId),
        isNull(apiKeys.revokedAt),
        or(
          isNull(apiKeys.expiresAt),
          gt(apiKeys.expiresAt, sql`statement_timestamp()`),
        ),
      ),
    )
    .limit(1);
  if (!row) unauthenticated();
}

async function gate(
  db: Database,
  scope: PlaybackScope,
  userId: string,
  credential: Claims["credential"],
) {
  const session = await liveSession(db, scope);
  if (session.userId !== userId) unauthenticated();
  await enabledOwner(db, userId);
  await liveCredential(db, userId, credential);
  await requirePermission(db, userId, "view", session.libraryId);
  await requirePermission(db, userId, "play");
}

/** Issues a signed playback token bound to a live session, its Item and the caller's credential. */
export async function issuePlaybackToken(
  db: Database,
  caller: PlaybackCaller,
  scope: PlaybackScope,
  now = Date.now(),
) {
  await gate(db, scope, caller.user.id, caller.credential);
  const exp = Math.floor(now / 1000) + playbackTokenLifetimeSeconds;
  const claims: Claims = {
    v: 1,
    sessionId: scope.sessionId,
    itemId: scope.itemId,
    userId: caller.user.id,
    credential: caller.credential,
    exp,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", await signingKey(db))
    .update(payload)
    .digest("base64url");
  return {
    token: `${payload}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Verifies a playback token against its scope and live auth state; returns its claims. */
export async function verifyPlaybackToken(
  db: Database,
  token: string,
  scope: PlaybackScope,
  now = Date.now(),
) {
  if (token.length > maxTokenLength) unauthenticated();
  const parts = token.split(".");
  if (parts.length !== 2) unauthenticated();
  const [payload, signature] = parts as [string, string];
  const payloadBytes = Buffer.from(payload, "base64url");
  const signatureBytes = Buffer.from(signature, "base64url");
  if (
    payloadBytes.length === 0 ||
    payloadBytes.toString("base64url") !== payload ||
    signatureBytes.length !== signatureByteLength ||
    signatureBytes.toString("base64url") !== signature
  )
    unauthenticated();
  const expected = createHmac("sha256", await signingKey(db))
    .update(payload)
    .digest();
  if (!timingSafeEqual(signatureBytes, expected)) unauthenticated();

  let claims: Claims;
  try {
    claims = Schema.decodeUnknownSync(Claims)(
      JSON.parse(payloadBytes.toString("utf8")),
    );
  } catch {
    unauthenticated();
  }
  if (claims.exp <= Math.floor(now / 1000)) unauthenticated();
  if (claims.sessionId !== scope.sessionId || claims.itemId !== scope.itemId)
    unauthenticated();
  await gate(db, scope, claims.userId, claims.credential);
  return claims;
}
