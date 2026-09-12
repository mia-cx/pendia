import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { groups, invites, userGroups, users } from "../db/schema/index.ts";
import { prepareLocalAccount, publicUserFields } from "./accounts.ts";
import { AuthError, postgresCode } from "./errors.ts";
import { requirePermission } from "./permissions.ts";
import { issueSession } from "./sessions.ts";
import { readAuthSettings } from "./settings.ts";

type AcceptLocalInput = {
  token: string;
  username: string;
  password: string;
  displayName?: string;
  clientName: string;
  deviceId: string;
  deviceName: string;
};

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const emailPattern = /^[^\s@]+@[^\s@]+$/;
const maxSeconds = 315_360_000;

const safeInviteFields = {
  id: invites.id,
  email: invites.email,
  invitedBy: invites.invitedBy,
  expiresAt: invites.expiresAt,
  acceptedAt: invites.acceptedAt,
};

/** Creates an expiring invite for an actor with manage-users. */
export async function createInvite(
  db: Database,
  actorId: string,
  input: { email: string; expiresInSeconds: number },
) {
  await requirePermission(db, actorId, "manage-users");
  const email = input.email.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !emailPattern.test(email) ||
    !Number.isSafeInteger(input.expiresInSeconds) ||
    input.expiresInSeconds < 1 ||
    input.expiresInSeconds > maxSeconds
  )
    throw new AuthError("INVALID_INPUT");
  const token = randomBytes(32).toString("base64url");
  try {
    const [invite] = await db
      .insert(invites)
      .values({
        email,
        tokenHash: createHash("sha256").update(token).digest(),
        invitedBy: actorId,
        expiresAt: sql`clock_timestamp() + ${input.expiresInSeconds} * interval '1 second'`,
      })
      .returning(safeInviteFields);
    if (!invite) throw new Error("Invite insert returned no row.");
    return { token, invite };
  } catch (error) {
    if (postgresCode(error) === "23505") throw new AuthError("CONFLICT");
    throw error;
  }
}

/** Accepts a live invite as a local account and returns its first session. */
export async function acceptLocalInvite(db: Database, input: AcceptLocalInput) {
  if (!tokenPattern.test(input.token)) throw new AuthError("INVALID_INVITE");
  const digest = createHash("sha256").update(input.token).digest();
  const [live] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, digest),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  if (!live) throw new AuthError("INVALID_INVITE");
  const prepared = await prepareLocalAccount(input);
  const config = await readAuthSettings(db);
  try {
    return await db.transaction(async (tx) => {
      const [invite] = await tx
        .update(invites)
        .set({ acceptedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(invites.tokenHash, digest),
            isNull(invites.acceptedAt),
            gt(invites.expiresAt, sql`statement_timestamp()`),
          ),
        )
        .returning({ email: invites.email });
      if (!invite) throw new AuthError("INVALID_INVITE");
      const [members] = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.name, "users"), eq(groups.builtIn, true)))
        .limit(1);
      if (!members)
        throw new Error("Seeded users group missing; run migrations first.");
      const [user] = await tx
        .insert(users)
        .values({ ...prepared, email: invite.email })
        .returning(publicUserFields);
      if (!user) throw new Error("User insert returned no row.");
      await tx
        .insert(userGroups)
        .values({ userId: user.id, groupId: members.id });
      return issueSession(tx, user.id, input, config.sessionMaxAgeSeconds);
    });
  } catch (error) {
    if (postgresCode(error) === "23505") throw new AuthError("CONFLICT");
    throw error;
  }
}
