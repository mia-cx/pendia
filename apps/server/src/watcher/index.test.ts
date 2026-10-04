import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import { libraries, probeCache, streams } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import type { WatchedChange } from "../libraries/webhooks.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
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

describe.skipIf(!databaseUrl)("watcher scans", () => {
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
