import { describe, expect, test } from "bun:test";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { listJobs } from "../jobs/queue.ts";
import { createChangeDebouncer } from "../libraries/webhooks.ts";
import { createWatcherHandler } from "./http.ts";

async function setup(db: Database) {
  await migrateDatabase(db);
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const { token } = await createApiKey(db, admin.id, "Watcher");
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: "/media/movies" })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  return { token, library };
}

function post(path: string, body: unknown, token?: string) {
  return new Request(`http://pendia.test/api/watcher/${path}`, {
    method: "POST",
    headers:
      token === undefined
        ? { "Content-Type": "application/json" }
        : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!databaseUrl)("watcher events", () => {
  test("rejects a missing, wrong or session token", () =>
    withDatabase(async (db) => {
      const { library } = await setup(db);
      const { token: sessionToken } = await login(
        db,
        {
          username: "admin",
          password: "admin-pass",
          clientName: "Test Client",
          deviceId: "device-1",
          deviceName: "Laptop",
        },
        "127.0.0.1",
      );
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      const handler = createWatcherHandler(db, debouncer);
      const batch = { libraryId: library.id, changes: [] };
      try {
        for (const token of [undefined, "x".repeat(43), sessionToken]) {
          const response = await handler(post("events", batch, token));
          expect(response?.status).toBe(401);
        }
      } finally {
        await debouncer.close();
      }
    }));

  test("rejects a path that escapes the library root", () =>
    withDatabase(async (db) => {
      const { token, library } = await setup(db);
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      const handler = createWatcherHandler(db, debouncer);
      try {
        for (const path of ["../Alien (1979)/Alien.mkv", "/etc/passwd"]) {
          const response = await handler(
            post(
              "events",
              { libraryId: library.id, changes: [{ kind: "add", path }] },
              token,
            ),
          );
          expect(response?.status).toBe(400);
        }
      } finally {
        await debouncer.close();
      }
      expect(await listJobs(db, { type: "scan" })).toHaveLength(0);
    }));

  test("a batch of file events becomes one scan job with relative paths", () =>
    withDatabase(async (db) => {
      const { token, library } = await setup(db);
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      const handler = createWatcherHandler(db, debouncer);
      try {
        const response = await handler(
          post(
            "events",
            {
              libraryId: library.id,
              changes: [
                { kind: "add", path: "Alien (1979)/Alien.mkv.part" },
                {
                  kind: "move",
                  path: "Alien (1979)/Alien.mkv",
                  previousPath: "Alien (1979)/Alien.mkv.part",
                },
                {
                  kind: "move",
                  path: "Alien (1979)/Alien (1979).mkv",
                  previousPath: "Alien (1979)/Alien.mkv",
                },
                { kind: "delete", path: "Alien (1979)/Alien (1979).en.srt" },
                { kind: "delete", path: "Alien (1979)/Alien (1979).mkv" },
              ],
            },
            token,
          ),
        );
        expect(response?.status).toBe(202);
        expect(await response?.json()).toEqual({ accepted: 3 });
      } finally {
        await debouncer.close();
      }
      const jobs = await listJobs(db, { type: "scan" });
      expect(jobs.map((job) => job.payload)).toEqual([
        {
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
          changes: [
            { kind: "add", path: "Alien (1979)/Alien.mkv", providerIds: {} },
            {
              kind: "move",
              path: "Alien (1979)/Alien (1979).mkv",
              previousPath: "Alien (1979)/Alien.mkv",
              providerIds: {},
            },
            {
              kind: "delete",
              path: "Alien (1979)/Alien (1979).mkv",
              target: "file",
              providerIds: {},
            },
          ],
        },
      ]);
    }));
});
