import { describe, expect, test } from "bun:test";
import {
  createPendiaClient,
  type PendiaClient,
} from "../../../web/src/lib/api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

type Extends<A, B> = A extends B ? true : false;

type ListOutput = Awaited<ReturnType<PendiaClient["items"]["list"]>>;
type MeOutput = Awaited<ReturnType<PendiaClient["me"]>>;

type PlainCard = {
  id: string;
  kind: "movie" | "show" | "season" | "episode";
  libraryId: string;
  title: string;
  year: number | null;
  addedAt: string;
};

type PlainList = { items: readonly PlainCard[]; cursor: string | null };

type PlainMe = {
  user: { id: string; username: string; displayName: string };
  credential: { kind: "session" | "api-key"; id: string };
};

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const { token } = await login(
    db,
    { username: "admin", password: "admin-pass", ...device },
    "127.0.0.1",
  );
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: "/srv/movies" })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  const rows = [];
  for (const index of [0, 1, 2]) {
    const [row] = await db
      .insert(items)
      .values({
        libraryId: library.id,
        kind: "movie",
        title: `Movie ${index}`,
        canonicalFolder: `/srv/movies/movie-${index}`,
        addedAt: new Date(Date.UTC(2026, 0, 10, 0, 0, index)),
      })
      .returning();
    if (!row) throw new Error("Item insert returned no row.");
    rows.push(row);
  }
  return { admin, token, rows };
}

describe.skipIf(!databaseUrl)("api client", () => {
  test("the web client answers me and pages items over RPC", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token, rows } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const client = createPendiaClient({
          origin: base,
          headers: { authorization: `Bearer ${token}` },
        });
        const me = await client.me();
        expect(me.user).toMatchObject({ id: admin.id, username: "admin" });
        expect(me.credential.kind).toBe("session");

        const first = await client.items.list({ limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.items.map((item) => item.id)).toEqual(
          rows
            .map((row) => row.id)
            .reverse()
            .slice(0, 2),
        );
        expect(first.cursor).not.toBeNull();
        if (first.cursor === null) throw new Error("Expected a cursor.");
        const rest = await client.items.list({
          limit: 2,
          cursor: first.cursor,
        });
        expect(rest.items.map((item) => item.id)).toEqual(
          rows
            .map((row) => row.id)
            .reverse()
            .slice(2),
        );
        expect(rest.cursor).toBeNull();
      } finally {
        await server.stop();
      }
    }));

  test("the client-facing types are plain JSON shapes", () => {
    const listIsPlain: [
      Extends<ListOutput, PlainList>,
      Extends<PlainList, ListOutput>,
    ] = [true, true];
    const meIsPlain: [Extends<MeOutput, PlainMe>, Extends<PlainMe, MeOutput>] =
      [true, true];
    expect(listIsPlain).toEqual([true, true]);
    expect(meIsPlain).toEqual([true, true]);
  });
});
