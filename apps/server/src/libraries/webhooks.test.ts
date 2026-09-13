import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import { createDatabase, type Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { listJobs } from "../jobs/queue.ts";
import { libraryConcurrencyKey } from "./jobs.ts";
import type { ChangeEvent } from "./servarr.ts";
import {
  createChangeDebouncer,
  createServarrWebhookHandler,
} from "./webhooks.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

const movieIds = { tmdb: "348", imdb: "tt0078748" };

async function loadFixture(name: string): Promise<unknown> {
  const text = await readFile(
    join(import.meta.dir, "fixtures", "servarr", name),
    "utf8",
  );
  const payload: unknown = JSON.parse(text);
  return payload;
}

async function insertLibrary(
  db: Database,
  name: string,
  rootPath: string,
  medium: "movies" | "shows" = "movies",
) {
  const [library] = await db
    .insert(libraries)
    .values({ name, medium, rootPath })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

async function waitForScanJobs(db: Database, count: number) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const found = await listJobs(db, { state: "queued", type: "scan" });
    if (found.length >= count) return found;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for ${count} queued scan jobs; found ${found.length}.`,
      );
    await Bun.sleep(10);
  }
}

describe.skipIf(!databaseUrl)("servarr webhooks", () => {
  test("three changes for one movie directory become one scan job", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await debouncer.submit("radarr", [
          {
            kind: "add",
            path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
            providerIds: movieIds,
          },
          {
            kind: "move",
            path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-2160p].mkv",
            previousPath:
              "/media/movies/Alien (1979) {tmdb-348}/Alien.1979.2160p.BluRay.mkv",
            providerIds: movieIds,
          },
          {
            kind: "delete",
            path: "/media/movies/Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
            target: "file",
            providerIds: movieIds,
          },
        ]);
        const jobs = await waitForScanJobs(db, 1);
        await Bun.sleep(30);
        expect(await listJobs(db, { type: "scan" })).toHaveLength(1);
        expect(jobs[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979) {tmdb-348}",
          changes: [
            {
              kind: "add",
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
              providerIds: movieIds,
            },
            {
              kind: "move",
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-2160p].mkv",
              previousPath:
                "Alien (1979) {tmdb-348}/Alien.1979.2160p.BluRay.mkv",
              providerIds: movieIds,
            },
            {
              kind: "delete",
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
              target: "file",
              providerIds: movieIds,
            },
          ],
        });
        expect(jobs[0]?.concurrencyKey).toBe(libraryConcurrencyKey(library.id));
      } finally {
        await debouncer.close();
      }
    }));

  test("changes in two directories become two scan jobs", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await debouncer.submit("radarr", [
          {
            kind: "add",
            path: "/media/movies/Alien (1979)/Alien.mkv",
            providerIds: {},
          },
          {
            kind: "add",
            path: "/media/movies/Blade Runner (1982)/Blade Runner.mkv",
            providerIds: {},
          },
        ]);
        const jobs = await waitForScanJobs(db, 2);
        expect(jobs.map((job) => job.payload)).toEqual(
          expect.arrayContaining([
            {
              type: "scan",
              libraryId: library.id,
              path: "Alien (1979)",
              changes: [
                {
                  kind: "add",
                  path: "Alien (1979)/Alien.mkv",
                  providerIds: {},
                },
              ],
            },
            {
              type: "scan",
              libraryId: library.id,
              path: "Blade Runner (1982)",
              changes: [
                {
                  kind: "add",
                  path: "Blade Runner (1982)/Blade Runner.mkv",
                  providerIds: {},
                },
              ],
            },
          ]),
        );
        for (const job of jobs)
          expect(job.concurrencyKey).toBe(libraryConcurrencyKey(library.id));
      } finally {
        await debouncer.close();
      }
    }));

  test("close flushes pending changes once and stays idempotent", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 60_000 });
      await debouncer.submit("radarr", [
        {
          kind: "delete",
          path: "/media/movies/Alien (1979)",
          target: "item",
          providerIds: movieIds,
        },
      ]);
      await debouncer.close();
      await debouncer.close();
      const jobs = await listJobs(db, { type: "scan" });
      expect(jobs.map((job) => job.payload)).toEqual([
        {
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
          changes: [
            {
              kind: "delete",
              path: "Alien (1979)",
              target: "item",
              providerIds: movieIds,
            },
          ],
        },
      ]);
    }));

  test("nested same-medium libraries bind the most specific root", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await insertLibrary(db, "Movies", "/media/movies");
      const anime = await insertLibrary(db, "Anime", "/media/movies/anime");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await debouncer.submit("radarr", [
          {
            kind: "add",
            path: "/media/movies/anime/Cowboy Bebop (1998)/Cowboy Bebop.mkv",
            providerIds: {},
          },
        ]);
        const jobs = await waitForScanJobs(db, 1);
        expect(jobs[0]?.payload).toEqual({
          type: "scan",
          libraryId: anime.id,
          path: "Cowboy Bebop (1998)",
          changes: [
            {
              kind: "add",
              path: "Cowboy Bebop (1998)/Cowboy Bebop.mkv",
              providerIds: {},
            },
          ],
        });
        expect(jobs[0]?.concurrencyKey).toBe(libraryConcurrencyKey(anime.id));
        await expect(
          debouncer.submit("radarr", [
            {
              kind: "move",
              path: "/media/movies/anime/Cowboy Bebop (1998)/Cowboy Bebop.mkv",
              previousPath:
                "/media/movies/Cowboy Bebop (1998)/Cowboy Bebop.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        await Bun.sleep(30);
        expect(await listJobs(db, { type: "scan" })).toHaveLength(1);
      } finally {
        await debouncer.close();
      }
    }));

  test("close waits for a submission blocked on the libraries lock", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const debouncer = createChangeDebouncer(db, { delayMs: 60_000 });
      const second = createDatabase(url);
      let release = () => {};
      try {
        const locked = second.db.transaction(async (tx) => {
          await tx.execute(sql`lock table libraries in access exclusive mode`);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        });
        const lockDeadline = Date.now() + 2_000;
        for (;;) {
          const rows = await db.$client<{ count: number }[]>`
            select count(*)::integer as count from pg_locks
            where locktype = 'relation' and granted
              and mode = 'AccessExclusiveLock'
              and relation = 'libraries'::regclass`;
          if ((rows[0]?.count ?? 0) > 0) break;
          if (Date.now() >= lockDeadline) {
            throw new Error("Libraries lock was not observed.");
          }
          await Bun.sleep(10);
        }
        const submission = debouncer.submit("radarr", [
          {
            kind: "add",
            path: "/media/movies/Alien (1979)/Alien.mkv",
            providerIds: {},
          },
        ]);
        const deadline = Date.now() + 2_000;
        for (;;) {
          const rows = await db.$client<{ count: number }[]>`
            select count(*)::integer as count from pg_locks
            where locktype = 'relation' and not granted
              and relation = 'libraries'::regclass`;
          if ((rows[0]?.count ?? 0) > 0) break;
          if (Date.now() >= deadline) {
            throw new Error("Submit lock wait was not observed.");
          }
          await Bun.sleep(10);
        }
        let closeResolved = false;
        const closing = debouncer.close();
        void closing.then(
          () => {
            closeResolved = true;
          },
          () => {},
        );
        await Bun.sleep(50);
        expect(closeResolved).toBe(false);
        release();
        await submission;
        await closing;
        const found = await listJobs(db, { type: "scan" });
        expect(found).toHaveLength(1);
        expect(found[0]?.payload).toEqual({
          type: "scan",
          libraryId: library.id,
          path: "Alien (1979)",
          changes: [
            {
              kind: "add",
              path: "Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ],
        });
        await locked;
      } finally {
        release();
        await second.close();
      }
    }));

  test("a failed timer flush retries the same ordered batch", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const library = await insertLibrary(db, "Movies", "/media/movies");
      const errors: unknown[] = [];
      const debouncer = createChangeDebouncer(db, {
        delayMs: 30,
        onError: (error) => {
          errors.push(error);
        },
      });
      await debouncer.submit("radarr", [
        {
          kind: "add",
          path: "/media/movies/Alien (1979)/Alien.1080p.mkv",
          providerIds: {},
        },
        {
          kind: "delete",
          path: "/media/movies/Alien (1979)/Alien.720p.mkv",
          target: "file",
          providerIds: {},
        },
      ]);
      await db.execute(sql`alter table jobs rename to jobs_paused`);
      const deadline = Date.now() + 2_000;
      while (errors.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      await db.execute(sql`alter table jobs_paused rename to jobs`);
      const jobs = await waitForScanJobs(db, 1);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual({
        type: "scan",
        libraryId: library.id,
        path: "Alien (1979)",
        changes: [
          {
            kind: "add",
            path: "Alien (1979)/Alien.1080p.mkv",
            providerIds: {},
          },
          {
            kind: "delete",
            path: "Alien (1979)/Alien.720p.mkv",
            target: "file",
            providerIds: {},
          },
        ],
      });
      await debouncer.close();
    }));

  test("a permanent flush failure keeps reporting and close rejects", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await insertLibrary(db, "Movies", "/media/movies");
      const errors: unknown[] = [];
      const debouncer = createChangeDebouncer(db, {
        delayMs: 100,
        onError: (error) => {
          errors.push(error);
          throw new Error("Reporting failed.");
        },
      });
      await debouncer.submit("radarr", [
        {
          kind: "add",
          path: "/media/movies/Alien (1979)/Alien.mkv",
          providerIds: {},
        },
      ]);
      await db.execute(sql`drop table jobs`);
      const deadline = Date.now() + 2_000;
      while (errors.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      await expect(debouncer.close()).rejects.toThrow();
    }));

  test("duplicate library roots reject as ambiguous", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await insertLibrary(db, "Movies A", "/media/movies");
      await insertLibrary(db, "Movies B", "/media/movies/");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await expect(
          debouncer.submit("radarr", [
            {
              kind: "add",
              path: "/media/movies/Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        await Bun.sleep(30);
        expect(await listJobs(db, { type: "scan" })).toEqual([]);
      } finally {
        await debouncer.close();
      }
    }));

  test("a debouncer defect rejects instead of answering 400", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const { token } = await createApiKey(db, admin.id, "Radarr");
      const failing = {
        submit: (_source: "sonarr" | "radarr", _changes: ChangeEvent[]) =>
          Promise.reject(new Error("database unavailable")),
        close: () => Promise.resolve(),
      };
      const handler = createServarrWebhookHandler(db, failing);
      const request = new Request(
        `http://pendia.test/api/webhooks/radarr/${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(await loadFixture("radarr-download.json")),
        },
      );
      await expect(handler(request)).rejects.toThrow("database unavailable");
    }));

  test("unmatched paths and cross-library moves reject without jobs", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await insertLibrary(db, "Movies", "/media/movies");
      await insertLibrary(db, "More Movies", "/media/other");
      const debouncer = createChangeDebouncer(db, { delayMs: 10 });
      try {
        await expect(
          debouncer.submit("radarr", [
            {
              kind: "move",
              path: "/media/movies/Alien (1979)/Alien.mkv",
              previousPath: "/media/other/Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        await expect(
          debouncer.submit("radarr", [
            {
              kind: "add",
              path: "/downloads/Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        await expect(
          debouncer.submit("radarr", [
            { kind: "add", path: "Alien (1979)/Alien.mkv", providerIds: {} },
          ]),
        ).rejects.toThrow();
        await expect(
          debouncer.submit("sonarr", [
            {
              kind: "add",
              path: "/media/movies/Alien (1979)/Alien.mkv",
              providerIds: {},
            },
          ]),
        ).rejects.toThrow();
        expect(await listJobs(db, { type: "scan" })).toEqual([]);
      } finally {
        await debouncer.close();
      }
    }));

  test("the api role accepts api-key webhooks and rejects other callers", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const { token: sonarrToken } = await createApiKey(db, admin.id, "Sonarr");
      const { token: radarrToken } = await createApiKey(db, admin.id, "Radarr");
      const { token: sessionToken } = await login(
        db,
        { username: "admin", password: "admin-pass", ...device },
        "127.0.0.1",
      );
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token: viewerToken } = await createApiKey(
        db,
        viewer.id,
        "Viewer",
      );
      const movies = await insertLibrary(db, "Movies", "/media/movies");
      const shows = await insertLibrary(db, "Shows", "/media/shows", "shows");
      const server = await startPendia("api", {
        databaseUrl: url,
        port: 0,
        changeOptions: { delayMs: 10 },
      });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const post = (provider: string, secret: string, body: unknown) =>
          fetch(`${base}/api/webhooks/${provider}/${secret}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          });

        const radarrPayload = await loadFixture("radarr-download.json");
        const accepted = await post("radarr", radarrToken, radarrPayload);
        expect(accepted.status).toBe(202);
        expect(await accepted.json()).toEqual({ accepted: 2 });
        const jobs = await waitForScanJobs(db, 1);
        expect(jobs[0]?.payload).toEqual({
          type: "scan",
          libraryId: movies.id,
          path: "Alien (1979) {tmdb-348}",
          changes: [
            {
              kind: "add",
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [Bluray-1080p].mkv",
              providerIds: movieIds,
            },
            {
              kind: "delete",
              path: "Alien (1979) {tmdb-348}/Alien (1979) {tmdb-348} [WEBDL-720p].mkv",
              target: "file",
              providerIds: movieIds,
            },
          ],
        });
        expect(jobs[0]?.concurrencyKey).toBe(libraryConcurrencyKey(movies.id));

        expect((await post("radarr", sonarrToken, radarrPayload)).status).toBe(
          202,
        );
        expect(
          (
            await post(
              "sonarr",
              sonarrToken,
              await loadFixture("sonarr-download.json"),
            )
          ).status,
        ).toBe(202);
        const all = await waitForScanJobs(db, 3);
        expect(
          all.some(
            (job) =>
              job.payload.type === "scan" &&
              job.payload.libraryId === shows.id &&
              job.payload.path === "Foundation/Season 1",
          ),
        ).toBe(true);

        const wrongSecret = "x".repeat(43);
        for (const provider of ["sonarr", "radarr"]) {
          const response = await post(provider, wrongSecret, radarrPayload);
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({
            error: {
              code: "UNAUTHENTICATED",
              message: "Authentication required.",
            },
          });
        }
        expect((await post("radarr", sessionToken, radarrPayload)).status).toBe(
          401,
        );
        expect((await post("radarr", viewerToken, radarrPayload)).status).toBe(
          403,
        );

        const malformed = await post("radarr", radarrToken, {
          eventType: "Download",
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid webhook payload.",
          },
        });
        expect((await post("radarr", radarrToken, "{not json")).status).toBe(
          400,
        );

        const get = await fetch(`${base}/api/webhooks/radarr/${radarrToken}`);
        expect(get.status).toBe(405);
        expect(get.headers.get("allow")).toBe("POST");

        expect((await fetch(`${base}/api/libraries`)).status).toBe(401);
      } finally {
        await server.stop();
      }
    }));
});
