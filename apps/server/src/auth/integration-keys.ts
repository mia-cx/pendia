import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { settings } from "../db/schema/index.ts";
import { listUsers } from "./admin.ts";
import { AuthError } from "./errors.ts";
import { requireAdmin } from "./permissions.ts";
import { createApiKey, listApiKeys, revokeApiKey } from "./sessions.ts";

const encryptionKeySetting = "auth.integrationKeyEncryptionKey";
const keyPrefix = "auth.integrationKey.";
const nonceBytes = 12;

async function encryptionKey(db: Database) {
  await db
    .insert(settings)
    .values({
      key: encryptionKeySetting,
      value: randomBytes(32).toString("base64url"),
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, encryptionKeySetting));
  if (typeof row?.value !== "string")
    throw new Error("Missing integration encryption key.");
  return Buffer.from(row.value, "base64url");
}

/** Creates a recoverable integration credential for administrator-managed clients. Device credentials remain hash-only. */
export async function createIntegrationKey(
  db: Database,
  actorId: string,
  name: string,
) {
  await requireAdmin(db, actorId);
  const key = await encryptionKey(db);
  return db.transaction(async (tx) => {
    const issued = await createApiKey(tx, actorId, name);
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(issued.key.id));
    const encrypted = Buffer.concat([
      cipher.update(issued.token, "utf8"),
      cipher.final(),
    ]);
    await tx.insert(settings).values({
      key: `${keyPrefix}${issued.key.id}`,
      value: {
        nonce: nonce.toString("base64url"),
        ciphertext: encrypted.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      },
    });
    return issued;
  });
}

/** Lists integration credentials for an administrator; ordinary one-time keys have no recoverable token. */
export async function listIntegrationKeys(db: Database, actorId: string) {
  await requireAdmin(db, actorId);
  const key = await encryptionKey(db);
  const accounts = await listUsers(db, actorId);
  const rows = await Promise.all(
    accounts.map(async (user) =>
      (await listApiKeys(db, actorId, user.id)).map((key) => ({
        ...key,
        username: user.username,
      })),
    ),
  );
  return Promise.all(
    rows
      .flat()
      .filter((row) => row.revokedAt === null)
      .map(async (row) => {
        const [stored] = await db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, `${keyPrefix}${row.id}`));
        const value = stored?.value;
        if (value === undefined) return { ...row, token: null };
        if (
          value === null ||
          Array.isArray(value) ||
          typeof value !== "object" ||
          typeof value.nonce !== "string" ||
          typeof value.ciphertext !== "string" ||
          typeof value.tag !== "string"
        )
          throw new Error("Corrupt integration credential.");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(value.nonce, "base64url"),
        );
        decipher.setAAD(Buffer.from(row.id));
        decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
        const token = Buffer.concat([
          decipher.update(Buffer.from(value.ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
        return { ...row, token };
      }),
  );
}

/** Revokes an administrator-managed integration key by its token or core identifier. */
export async function revokeIntegrationKey(
  db: Database,
  actorId: string,
  token: string,
) {
  const row = (await listIntegrationKeys(db, actorId)).find(
    (key) => key.token === token || key.id === token,
  );
  if (row === undefined) throw new AuthError("NOT_FOUND");
  await revokeApiKey(db, actorId, row.id);
  await db.delete(settings).where(eq(settings.key, `${keyPrefix}${row.id}`));
}
