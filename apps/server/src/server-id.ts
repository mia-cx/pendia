import { eq } from "drizzle-orm";
import type { Database } from "./db/client.ts";
import { settings } from "./db/schema/index.ts";

const serverIdKey = "server.id";

/** Reads this server's stable id, creating it on first use. Clients key saved servers by it. */
export async function readServerId(db: Database): Promise<string> {
  const read = async () => {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, serverIdKey))
      .limit(1);
    return typeof row?.value === "string" ? row.value : undefined;
  };
  const stored = await read();
  if (stored !== undefined) return stored;
  await db
    .insert(settings)
    .values({ key: serverIdKey, value: Bun.randomUUIDv7() })
    .onConflictDoNothing({ target: settings.key });
  const created = await read();
  if (created === undefined) throw new Error("Server id is missing.");
  return created;
}
