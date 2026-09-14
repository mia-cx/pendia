import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createPendiaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { sessionCookieName } from "../auth/http.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { files, items, libraries, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { listJobs } from "../jobs/queue.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

type SseFrame = { id: string | undefined; data: string };

function parseFrame(raw: string): SseFrame | undefined {
  let id: string | undefined;
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  return data === "" ? undefined : { id, data };
}

function openStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  let ended = false;
  const pumping = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = parseFrame(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          if (frame !== undefined) frames.push(frame);
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      ended = true;
    }
  })();
  return {
    frames,
    async waitForMatch(match: (data: unknown) => boolean, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (!ended && Date.now() < deadline) {
        for (const frame of frames) {
          const data: unknown = JSON.parse(frame.data);
          if (match(data)) return data;
        }
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for a matching SSE frame.");
    },
    async close() {
      await reader.cancel().catch(() => {});
      await pumping.catch(() => {});
    },
  };
}

async function openEvents(base: string, token: string) {
  const response = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("The event stream has no body.");
  return openStream(response.body);
}

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
  return { admin, token };
}

async function waitForLibraryJobs(db: Database, libraryId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const jobs = (await listJobs(db, { type: "scan" })).filter(
      (job) =>
        job.payload.type === "scan" && job.payload.libraryId === libraryId,
    );
    if (jobs.some((job) => job.state === "failed"))
      throw new Error(
        `Scan job failed: ${JSON.stringify(jobs.map((job) => job.error))}`,
      );
    if (jobs.length >= 2 && jobs.every((job) => job.state === "completed"))
      return jobs;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for scan jobs: ${JSON.stringify(jobs.map((job) => job.state))}`,
      );
    await Bun.sleep(20);
  }
}

async function populate(root: string) {
  const folder = join(root, "Alien (1979)");
  await mkdir(folder, { recursive: true });
  await createVideoFixture(join(folder, "Alien.mkv"), { width: 1920 });
  await createVideoFixture(join(folder, "Alien.720p.mkv"), {
    width: 1280,
    height: 720,
  });
}

describe.skipIf(!databaseUrl)("libraries api", () => {
  test("create, read, update, scan and delete over RPC and REST", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      await withVideoFixture(async (root) => {
        await populate(root);
        const server = await startPendia("all", {
          databaseUrl: url,
          port: 0,
          workerOptions: { pollIntervalMs: 20 },
        });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = createPendiaClient({
            origin: base,
            headers: { authorization: `Bearer ${token}` },
          });
          const created = await client.libraries.create({
            name: "Movies",
            medium: "movies",
            rootPath: root,
          });
          expect(created).toMatchObject({
            name: "Movies",
            medium: "movies",
            rootPath: root,
          });

          const get = await fetch(`${base}/api/libraries/${created.id}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(get.status).toBe(200);
          expect(await get.json()).toEqual(created);
          const list = await fetch(`${base}/api/libraries`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(await list.json()).toEqual([created]);

          const patch = await fetch(`${base}/api/libraries/${created.id}`, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: "Film Collection" }),
          });
          expect(patch.status).toBe(200);
          expect(await patch.json()).toEqual({
            ...created,
            name: "Film Collection",
          });

          const stream = await openEvents(base, token);
          try {
            const { jobId } = await client.libraries.scan({ id: created.id });
            const jobs = await waitForLibraryJobs(db, created.id);
            expect(jobs.map((job) => job.id)).toContain(jobId);
            expect(
              jobs
                .map((job) => job.payload)
                .sort((a, b) =>
                  (a.type === "scan" ? a.path : "").localeCompare(
                    b.type === "scan" ? b.path : "",
                  ),
                ),
            ).toEqual([
              { type: "scan", libraryId: created.id, path: "." },
              {
                type: "scan",
                libraryId: created.id,
                path: "Alien (1979)",
                reconcileMissing: true,
              },
            ]);
            for (const job of jobs)
              expect(job.concurrencyKey).toBe(`library:${created.id}`);
            const event = await stream.waitForMatch(
              (data) =>
                typeof data === "object" &&
                data !== null &&
                (data as { libraryId?: string }).libraryId === created.id,
              10_000,
            );
            expect(event).toEqual({
              kind: "library.changed",
              libraryId: created.id,
            });
          } finally {
            await stream.close();
          }

          const scanned = await db
            .select()
            .from(items)
            .where(eq(items.libraryId, created.id));
          expect(scanned).toHaveLength(1);
          expect(scanned[0]).toMatchObject({
            kind: "movie",
            title: "Alien",
            year: 1979,
            canonicalFolder: "Alien (1979)",
          });
          expect(
            await db
              .select()
              .from(versions)
              .where(eq(versions.libraryId, created.id)),
          ).toHaveLength(2);

          const del = await fetch(`${base}/api/libraries/${created.id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          });
          expect(del.status).toBe(200);
          expect(await del.json()).toEqual({ ok: true });
          expect(await client.libraries.list()).toEqual([]);
        } finally {
          await server.stop();
        }
      });
    }));

  test("library routes reject bad credentials and input", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token: viewerToken } = await createApiKey(
        db,
        viewer.id,
        "viewer",
      );
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const adminHeaders = { authorization: `Bearer ${token}` };
        const viewerHeaders = { authorization: `Bearer ${viewerToken}` };

        expect((await fetch(`${base}/api/libraries`)).status).toBe(401);
        expect(
          (await fetch(`${base}/api/libraries`, { headers: viewerHeaders }))
            .status,
        ).toBe(403);
        expect(
          (
            await fetch(`${base}/api/libraries/not-a-uuid`, {
              headers: adminHeaders,
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await fetch(`${base}/api/libraries/${Bun.randomUUIDv7()}`, {
              headers: adminHeaders,
            })
          ).status,
        ).toBe(404);
        const post = (body: unknown, headers: Record<string, string>) =>
          fetch(`${base}/api/libraries`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          });
        const created = await post(
          { name: "Shows", medium: "shows", rootPath: "/srv/shows" },
          adminHeaders,
        );
        expect(created.status).toBe(200);
        const showsLibrary = (await created.json()) as { id: string };
        const deleted = await fetch(
          `${base}/api/libraries/${showsLibrary.id}`,
          { method: "DELETE", headers: adminHeaders },
        );
        expect(deleted.status).toBe(200);
        expect(
          (
            await post(
              { name: "Movies", medium: "movies", rootPath: "relative" },
              adminHeaders,
            )
          ).status,
        ).toBe(400);
        expect(
          (
            await post(
              { name: "Movies", medium: "movies", rootPath: "/srv/movies" },
              viewerHeaders,
            )
          ).status,
        ).toBe(403);
      } finally {
        await server.stop();
      }
    }));

  test("creates and scans a shows library through the default worker", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      await withVideoFixture(async (root) => {
        const specialsDir = join(root, "Show (2020)", "Specials");
        const seasonDir = join(root, "Show (2020)", "Season 01");
        await mkdir(specialsDir, { recursive: true });
        await mkdir(seasonDir, { recursive: true });
        await createVideoFixture(join(specialsDir, "Show S00E01.mkv"));
        await createVideoFixture(join(seasonDir, "Show S01E01 - part1.mkv"));
        await createVideoFixture(join(seasonDir, "Show S01E01 - part2.mkv"));
        await createVideoFixture(join(seasonDir, "Show S01E02-E03.mkv"));
        const server = await startPendia("all", {
          databaseUrl: url,
          port: 0,
          workerOptions: { pollIntervalMs: 20 },
        });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = createPendiaClient({
            origin: base,
            headers: { authorization: `Bearer ${token}` },
          });
          const library = await client.libraries.create({
            name: "Shows",
            medium: "shows",
            rootPath: root,
          });
          expect(library).toMatchObject({
            name: "Shows",
            medium: "shows",
            rootPath: root,
          });

          await client.libraries.scan({ id: library.id });
          const jobs = await waitForLibraryJobs(db, library.id);
          expect(jobs).toHaveLength(2);
          expect(
            jobs
              .map((job) => job.payload)
              .sort((a, b) =>
                (a.type === "scan" ? a.path : "").localeCompare(
                  b.type === "scan" ? b.path : "",
                ),
              ),
          ).toEqual([
            { type: "scan", libraryId: library.id, path: "." },
            {
              type: "scan",
              libraryId: library.id,
              path: "Show (2020)",
              reconcileMissing: true,
            },
          ]);
          for (const job of jobs) {
            expect(job.state).toBe("completed");
            expect(job.concurrencyKey).toBe(`library:${library.id}`);
          }

          const scanned = await db
            .select()
            .from(items)
            .where(eq(items.libraryId, library.id));
          expect(scanned).toHaveLength(6);
          const kindCounts = new Map<string, number>();
          for (const item of scanned) {
            kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1);
          }
          expect(Object.fromEntries(kindCounts)).toEqual({
            show: 1,
            season: 2,
            episode: 3,
          });
          expect(
            await db
              .select()
              .from(versions)
              .where(eq(versions.libraryId, library.id)),
          ).toHaveLength(3);
          expect(
            await db
              .select()
              .from(files)
              .where(eq(files.libraryId, library.id)),
          ).toHaveLength(4);
        } finally {
          await server.stop();
        }
      });
    }));

  test("mutations reject foreign origins and cross-site requests", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const body = (name: string) =>
          JSON.stringify({
            name,
            medium: "movies",
            rootPath: "/srv/movies",
          });
        const cookie = `${sessionCookieName}=${token}`;
        const foreign = await fetch(`${base}/api/libraries`, {
          method: "POST",
          headers: {
            cookie,
            origin: "https://evil.example",
            "content-type": "application/json",
          },
          body: body("Foreign"),
        });
        expect(foreign.status).toBe(403);
        const crossSite = await fetch(`${base}/api/libraries`, {
          method: "POST",
          headers: {
            cookie,
            "sec-fetch-site": "cross-site",
            "content-type": "application/json",
          },
          body: body("Cross Site"),
        });
        expect(crossSite.status).toBe(403);
        expect(await db.select({ id: libraries.id }).from(libraries)).toEqual(
          [],
        );
        const sameOrigin = await fetch(`${base}/api/libraries`, {
          method: "POST",
          headers: {
            cookie,
            origin: base,
            "content-type": "application/json",
          },
          body: body("Same Origin"),
        });
        expect(sameOrigin.status).toBe(200);
        const native = await fetch(`${base}/api/libraries`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: body("Native"),
        });
        expect(native.status).toBe(200);
      } finally {
        await server.stop();
      }
    }));

  test("each default runtime binds its own database", () =>
    withDatabase(async (dbA, urlA) => {
      await migrateDatabase(dbA);
      const { token: tokenA } = await seed(dbA);
      await withDatabase(async (dbB, urlB) => {
        await migrateDatabase(dbB);
        const { token: tokenB } = await seed(dbB);
        await withVideoFixture(async (root) => {
          await populate(root);
          for (const [db, url, token, name] of [
            [dbA, urlA, tokenA, "First"],
            [dbB, urlB, tokenB, "Second"],
          ] as const) {
            const server = await startPendia("all", {
              databaseUrl: url,
              port: 0,
              workerOptions: { pollIntervalMs: 20 },
            });
            try {
              const base = `http://127.0.0.1:${server.apiServer?.port}`;
              const client = createPendiaClient({
                origin: base,
                headers: { authorization: `Bearer ${token}` },
              });
              const library = await client.libraries.create({
                name,
                medium: "movies",
                rootPath: root,
              });
              await client.libraries.scan({ id: library.id });
              await waitForLibraryJobs(db, library.id);
              expect(
                await db
                  .select()
                  .from(items)
                  .where(eq(items.libraryId, library.id)),
              ).toHaveLength(1);
            } finally {
              await server.stop();
            }
          }
          expect((await dbA.select({ id: items.id }).from(items)).length).toBe(
            1,
          );
          expect((await dbB.select({ id: items.id }).from(items)).length).toBe(
            1,
          );
        });
      });
    }));
});
