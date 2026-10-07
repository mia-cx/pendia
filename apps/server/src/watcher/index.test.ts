import { describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  files,
  jobs,
  probeCache,
  scanFailures,
  streams,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { libraryConcurrencyKey } from "../libraries/jobs.ts";
import { insertLibraries } from "../libraries/testing.ts";
import {
  createChangeDebouncer,
  type WatchedChange,
} from "../libraries/webhooks.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { createWatcherHandler, type WatcherReport } from "./http.ts";
import { readWatcherConfig, startWatcher } from "./index.ts";

const rootId = "0199a000-0000-7000-8000-000000000001";

test.skipIf(!databaseUrl)(
  "watcher scans index healthy neighbours, reuse failures, and recover changed files",
  () =>
    withDatabase((db) =>
      withVideoFixture(async (root) => {
        await mkdir(join(root, "Show"));
        const good = "Show/Show S01E01.mkv";
        const bad = "Show/Show S01E02.mkv";
        await createVideoFixture(join(root, good));
        await writeFile(join(root, bad), "");
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const { token } = await createApiKey(db, admin.id, "Watcher");
        const [library] = await insertLibraries(db, {
          name: "Shows",
          medium: "shows",
          rootPath: "/nfs/shows",
        });
        if (!library) throw new Error("Fixture library missing.");
        const handler = createWatcherHandler(db, {
          submitWatched: () => Promise.reject(new Error("No events expected.")),
        });
        const reports: WatcherReport[] = [];
        const api = Bun.serve({
          port: 0,
          async fetch(request) {
            if (/\/api\/watcher\/jobs\//.test(new URL(request.url).pathname))
              reports.push(await request.clone().json());
            return (
              (await handler(request)) ?? new Response(null, { status: 404 })
            );
          },
        });
        const queue = createJobQueue(db);
        const run = async () => {
          const job = await queue.enqueue({
            type: "scan",
            libraryId: library.id,
            path: "Show",
            reconcileMissing: true,
          });
          const errors: unknown[] = [];
          const watcher = await startWatcher(
            {
              apiUrl: new URL(api.url),
              token,
              roots: new Map([[library.rootId, root]]),
            },
            {
              pollIntervalMs: 20,
              settleMs: 10_000,
              onError: (error) => errors.push(error),
            },
          );
          try {
            const deadline = Date.now() + 5_000;
            let written = (await db.select().from(jobs)).find(
              (row) => row.id === job.id,
            );
            while (written?.state !== "completed" && Date.now() < deadline) {
              await Bun.sleep(20);
              written = (await db.select().from(jobs)).find(
                (row) => row.id === job.id,
              );
            }
            expect(written).toMatchObject({ state: "completed", attempts: 1 });
            expect(
              errors.filter(
                (error) => !String(error).includes("heartbeat failed (409)"),
              ),
            ).toEqual([]);
          } finally {
            await watcher.stop();
          }
        };
        try {
          await run();
          expect(await db.select().from(files)).toMatchObject([{ path: good }]);
          const failures = await db.select().from(scanFailures);
          expect(failures).toMatchObject([{ path: bad, reason: "unreadable" }]);
          expect(reports[0]).toMatchObject({
            failures: [
              { path: bad, detail: expect.stringContaining("ffprobe failed") },
            ],
          });
          await run();
          expect(reports[1]).toMatchObject({ probes: [] });
          expect(reports[1]).not.toHaveProperty("failures");
          expect(await db.select().from(scanFailures)).toEqual(failures);
          await copyFile(join(root, good), join(root, bad));
          await run();
          expect(await db.select().from(files)).toHaveLength(2);
          expect(await db.select().from(scanFailures)).toEqual([]);
          expect(reports[2]).toMatchObject({ probes: [{ path: bad }] });
        } finally {
          await api.stop();
        }
      }),
    ),
);

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
  test("maps root ids to absolute local paths", () => {
    const config = readWatcherConfig({
      THALIA_API_URL: "http://thalia:3000",
      THALIA_WATCHER_TOKEN: "token",
      THALIA_WATCH: `${rootId}=/srv/movies,other=/srv/a=b`,
    });
    expect(config.apiUrl.href).toBe("http://thalia:3000/");
    expect([...config.roots]).toEqual([
      [rootId, "/srv/movies"],
      ["other", "/srv/a=b"],
    ]);
  });

  test("rejects a relative root", () => {
    expect(() =>
      readWatcherConfig({
        THALIA_API_URL: "http://thalia:3000",
        THALIA_WATCHER_TOKEN: "token",
        THALIA_WATCH: `${rootId}=movies`,
      }),
    ).toThrow("THALIA_WATCH");
  });
});

test("pushes adds, moves and deletes within 1 s with root-relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "thalia-watch-"));
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
      const batch: { rootId: string; changes: WatchedChange[] } =
        await request.json();
      expect(batch.rootId).toBe(rootId);
      seen.push(...batch.changes);
      return Response.json({ accepted: batch.changes.length }, { status: 202 });
    },
  });
  await mkdir(join(root, "Alien (1979)"));
  const watcher = await startWatcher({
    apiUrl: new URL(api.url),
    token: "watcher-token",
    roots: new Map([[rootId, root]]),
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
  const root = await mkdtemp(join(tmpdir(), "thalia-watch-"));
  const jobId = "0199a000-0000-7000-8000-000000000002";
  const claimToken = crypto.randomUUID();
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
                  claimToken,
                  libraryId: "0199a000-0000-7000-8000-000000000003",
                  rootIds: [rootId],
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
      roots: new Map([[rootId, root]]),
    },
    { pollIntervalMs: 20, onError: () => {} },
  );
  try {
    const deadline = Date.now() + 1_000;
    while (reports.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(reports).toEqual([
      { claimToken, files: [], probes: [], missing: [] },
      { claimToken, files: [], probes: [], missing: [] },
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
        const [library] = await insertLibraries(db, {
          name: "Movies",
          medium: "movies",
          rootPath: "/nfs/movies",
        });
        if (!library) throw new Error("Library insert returned no row.");
        const queue = createJobQueue(db);
        const first = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "Empty" },
          { concurrencyKey: libraryConcurrencyKey(library.id) },
        );
        const second = await queue.enqueue(
          { type: "scan", libraryId: library.id, path: "Other empty folder" },
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
        const root = await mkdtemp(join(tmpdir(), "thalia-watch-retry-"));
        const watcher = await startWatcher(
          {
            apiUrl: new URL(api.url),
            token,
            roots: new Map([[library.rootId, root]]),
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
          // The first copy settled the job, so heartbeats before the retry answer 409.
          const reportErrors = errors.filter(
            (error) => !String(error).includes("heartbeat failed (409)"),
          );
          expect(reportErrors).toHaveLength(failure === "after" ? 2 : 1);
          if (failure === "after")
            expect(String(reportErrors[1])).toContain("answered 404");
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
        const server = await startThalia("api", { databaseUrl: url, port: 0 });
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const { token } = await createApiKey(db, admin.id, "Watcher");
        // The api role has no worker, and this root does not exist on its disk.
        const [library] = await insertLibraries(db, {
          name: "Movies",
          medium: "movies",
          rootPath: "/nfs/movies",
        });
        if (!library) throw new Error("Library insert returned no row.");
        const watcher = await startWatcher(
          {
            apiUrl: new URL(base),
            token,
            roots: new Map([[library.rootId, dir]]),
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
            { rootId: library.rootId, path: "Alien (1979)/Alien (1979).mkv" },
          ]);
        } finally {
          await watcher.stop();
          await server.stop();
        }
      }),
    ));
});
