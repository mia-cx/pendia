import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { jobs, libraries, probeCache, streams } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { libraryConcurrencyKey } from "../libraries/jobs.ts";
import {
  createChangeDebouncer,
  type WatchedChange,
} from "../libraries/webhooks.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { createWatcherHandler } from "./http.ts";
import { readWatcherConfig, startWatcher } from "./index.ts";

const libraryId = "0199a000-0000-7000-8000-000000000001";

/** Waits up to `ms` for a pushed change that matches. */
async function waitForChange(
  seen: WatchedChange[],
  expected: WatchedChange,
  ms = 1_000,
) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (seen.some((change) => Bun.deepEquals(change, expected))) return;
    await Bun.sleep(10);
  }
  throw new Error(
    `No ${JSON.stringify(expected)} within ${ms} ms; saw ${JSON.stringify(seen)}.`,
  );
}

describe("readWatcherConfig", () => {
  test("maps Library ids to absolute local roots", () => {
    const config = readWatcherConfig({
      PENDIA_API_URL: "http://pendia:3000",
      PENDIA_WATCHER_TOKEN: "token",
      PENDIA_WATCH: `${libraryId}=/srv/movies,other=/srv/a=b`,
    });
    expect(config.apiUrl.href).toBe("http://pendia:3000/");
    expect([...config.roots]).toEqual([
      [libraryId, "/srv/movies"],
      ["other", "/srv/a=b"],
    ]);
  });

  test("rejects a relative root", () => {
    expect(() =>
      readWatcherConfig({
        PENDIA_API_URL: "http://pendia:3000",
        PENDIA_WATCHER_TOKEN: "token",
        PENDIA_WATCH: `${libraryId}=movies`,
      }),
    ).toThrow("PENDIA_WATCH");
  });
});

test("pushes adds, moves and deletes within 1 s with library-relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pendia-watch-"));
  const seen: WatchedChange[] = [];
  const authorizations = new Set<string | null>();
  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      authorizations.add(request.headers.get("authorization"));
      const { pathname } = new URL(request.url);
      if (pathname === "/api/watcher/claim")
        return Response.json({ job: null });
      if (pathname !== "/api/watcher/events")
        return new Response(null, { status: 404 });
      const batch: { libraryId: string; changes: WatchedChange[] } =
        await request.json();
      expect(batch.libraryId).toBe(libraryId);
      seen.push(...batch.changes);
      return Response.json({ accepted: batch.changes.length }, { status: 202 });
    },
  });
  await mkdir(join(root, "Alien (1979)"));
  const watcher = await startWatcher({
    apiUrl: new URL(api.url),
    token: "watcher-token",
    roots: new Map([[libraryId, root]]),
  });
  try {
    await writeFile(join(root, "Alien (1979)/Alien.mkv"), "frames");
    await waitForChange(seen, { kind: "add", path: "Alien (1979)/Alien.mkv" });

    await rename(
      join(root, "Alien (1979)/Alien.mkv"),
      join(root, "Alien (1979)/Alien (1979).mkv"),
    );
    await waitForChange(seen, {
      kind: "move",
      path: "Alien (1979)/Alien (1979).mkv",
      previousPath: "Alien (1979)/Alien.mkv",
    });

    await rename(
      join(root, "Alien (1979)"),
      join(root, "Alien (1979) [1080p]"),
    );
    await waitForChange(seen, {
      kind: "move",
      path: "Alien (1979) [1080p]/Alien (1979).mkv",
      previousPath: "Alien (1979)/Alien (1979).mkv",
    });

    await rm(join(root, "Alien (1979) [1080p]"), { recursive: true });
    await waitForChange(seen, {
      kind: "delete",
      path: "Alien (1979) [1080p]/Alien (1979).mkv",
    });

    expect(seen).toHaveLength(4);
    expect(authorizations).toEqual(new Set(["Bearer watcher-token"]));
  } finally {
    await watcher.stop();
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("retries a scan report the api refused with 403", async () => {
  const root = await mkdtemp(join(tmpdir(), "pendia-watch-"));
  const jobId = "0199a000-0000-7000-8000-000000000002";
  let claims = 0;
  const reports: unknown[] = [];
  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/watcher/claim")
        return Response.json({
          job:
            claims++ === 0
              ? {
                  id: jobId,
                  attempts: 1,
                  libraryId,
                  path: ".",
                  medium: "movies",
                  cached: [],
                  check: [],
                }
              : null,
        });
      if (pathname !== `/api/watcher/jobs/${jobId}`)
        return new Response(null, { status: 404 });
      reports.push(await request.json());
      // A Permission removed for a moment, then restored.
      return reports.length === 1
        ? new Response("forbidden", { status: 403 })
        : Response.json({ state: "completed" });
    },
  });
  const watcher = await startWatcher(
    {
      apiUrl: new URL(api.url),
      token: "t",
      roots: new Map([[libraryId, root]]),
    },
    { pollIntervalMs: 20, onError: () => {} },
  );
  try {
    const deadline = Date.now() + 1_000;
    while (reports.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(reports).toEqual([
      { attempts: 1, files: [], probes: [], missing: [] },
      { attempts: 1, files: [], probes: [], missing: [] },
    ]);
  } finally {
    await watcher.stop();
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(!databaseUrl)("watcher scans", () => {
  test.each(["before", "after"])(
    "retries a report that fails %s processing and unblocks the next scan",
    (failure) =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const { token } = await createApiKey(db, admin.id, "Watcher");
        const [library] = await db
          .insert(libraries)
          .values({ name: "Movies", medium: "movies", rootPath: "/nfs/movies" })
          .returning();
        if (!library) throw new Error("Library insert returned no row.");
        const queue = createJobQueue(db);
        const first = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "Empty" },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const second = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "Empty" },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const debouncer = createChangeDebouncer(db);
        const handler = createWatcherHandler(db, debouncer);
        const reports: unknown[] = [];
        const errors: unknown[] = [];
        let nextClaimed = false;
        const api = Bun.serve({
          port: 0,
          async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path.endsWith(`jobs/${first.id}`)) {
              reports.push(await request.clone().json());
              if (reports.length === 1) {
                if (failure === "after") await handler(request);
                return new Response("Unavailable", { status: 503 });
              }
            }
            const response = await handler(request);
            if (path.endsWith("/claim")) {
              const claimed = await response?.clone().json();
              if (claimed?.job?.id === second.id) nextClaimed = true;
            }
            return response ?? new Response(null, { status: 404 });
          },
        });
        const root = await mkdtemp(join(tmpdir(), "pendia-watch-retry-"));
        const watcher = await startWatcher(
          {
            apiUrl: new URL(api.url),
            token,
            roots: new Map([[library.id, root]]),
          },
          { pollIntervalMs: 20, onError: (error) => errors.push(error) },
        );
        try {
          const deadline = Date.now() + 3_000;
          let written = await db.select().from(jobs);
          while (
            written.some((job) => job.state !== "completed") &&
            Date.now() < deadline
          ) {
            await Bun.sleep(20);
            written = await db.select().from(jobs);
          }
          expect(written).toHaveLength(2);
          expect(written.map((job) => job.state)).toEqual([
            "completed",
            "completed",
          ]);
          expect(written.map((job) => job.attempts)).toEqual([1, 1]);
          expect(reports).toHaveLength(2);
          expect(reports[1]).toEqual(reports[0]);
          expect(nextClaimed).toBe(true);
          expect(errors).toHaveLength(failure === "after" ? 2 : 1);
          if (failure === "after")
            expect(String(errors[1])).toContain("answered 404");
        } finally {
          await watcher.stop();
          await api.stop();
          await debouncer.close();
          await rm(root, { recursive: true, force: true });
        }
      }),
  );

  test("a Library scan requested through the api runs on the watcher", () =>
    withVideoFixture((dir) =>
      withDatabase(async (db, url) => {
        await mkdir(join(dir, "Alien (1979)"));
        await createVideoFixture(join(dir, "Alien (1979)/Alien (1979).mkv"));
        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const { token } = await createApiKey(db, admin.id, "Watcher");
        // The api role has no worker, and this root does not exist on its disk.
        const [library] = await db
          .insert(libraries)
          .values({ name: "Movies", medium: "movies", rootPath: "/nfs/movies" })
          .returning();
        if (!library) throw new Error("Library insert returned no row.");
        const watcher = await startWatcher(
          {
            apiUrl: new URL(base),
            token,
            roots: new Map([[library.id, dir]]),
          },
          { pollIntervalMs: 50 },
        );
        try {
          const response = await fetch(
            `${base}/api/libraries/${library.id}/scan`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
            },
          );
          expect(response.status).toBe(200);
          const deadline = Date.now() + 10_000;
          let written = await db.select().from(streams);
          while (written.length === 0 && Date.now() < deadline) {
            await Bun.sleep(50);
            written = await db.select().from(streams);
          }
          expect(written.map((stream) => stream.kind)).toContain("video");
          expect(await db.select().from(probeCache)).toMatchObject([
            { libraryId: library.id, path: "Alien (1979)/Alien (1979).mkv" },
          ]);
        } finally {
          await watcher.stop();
          await server.stop();
        }
      }),
    ));
});
