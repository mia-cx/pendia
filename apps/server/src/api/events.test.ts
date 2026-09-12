import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import {
  authenticate,
  createApiKey,
  login,
  revokeSession,
} from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import {
  events,
  items,
  libraries,
  libraryAccess,
  sessionRegistry,
  versions,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { type Event, publishEvent, startEventBroker } from "./events.ts";

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

// Reads an SSE response body in the background so tests can wait for a
// frame count or inspect what has arrived so far.
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
    async waitFor(count: number, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < count && !ended) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await Bun.sleep(Math.min(20, remaining));
      }
      if (frames.length < count)
        throw new Error(
          `Timed out waiting for ${count} SSE frames; got ${frames.length}.`,
        );
      return frames.slice(0, count);
    },
    async waitUntilEnded(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (!ended && Date.now() < deadline) await Bun.sleep(20);
      if (!ended) throw new Error("Timed out waiting for the stream to end.");
    },
    async close() {
      await reader.cancel().catch(() => {});
      await pumping.catch(() => {});
    },
  };
}

async function openEvents(base: string, token: string, lastEventId?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
  const response = await fetch(`${base}/api/events`, { headers });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("The event stream has no body.");
  return openStream(response.body);
}

type Stream = Awaited<ReturnType<typeof openEvents>>;

function seen(stream: Stream) {
  return stream.frames.map((frame): unknown => JSON.parse(frame.data));
}

// Publishes until a frame arrives, which proves the subscriber finished its
// initial read and is parked on the wake. A publish that lands inside that
// first read is retried, so this cannot race.
async function park(db: Database, stream: Stream) {
  for (let attempt = 0; ; attempt++) {
    if (attempt === 10)
      throw new Error("The stream never received a warm-up event.");
    const want = stream.frames.length + 1;
    await publishEvent(db, {
      kind: "library.changed",
      libraryId: Bun.randomUUIDv7(),
    });
    try {
      await stream.waitFor(want, 1_000);
      return;
    } catch {
      // The publish raced the subscriber's first read; publish again.
    }
  }
}

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const { token, user, session } = await login(
    db,
    { username: "admin", password: "admin-pass", ...device },
    "127.0.0.1",
  );
  return { admin, token, user, session };
}

async function insertLibrary(db: Database, name: string) {
  const [library] = await db
    .insert(libraries)
    .values({
      name,
      medium: "movies",
      rootPath: `/srv/${name.toLowerCase()}`,
    })
    .returning();
  if (!library) throw new Error("Library insert returned no row.");
  return library;
}

// Publishes one event from a genuinely separate process so the test
// exercises Postgres NOTIFY crossing process boundaries.
async function publishFromProcess(url: string, event: object) {
  const dir = mkdtempSync(join(tmpdir(), "pendia-event-"));
  const file = join(dir, "publish.ts");
  try {
    writeFileSync(
      file,
      `import { createDatabase } from "${import.meta.dir}/../db/client.ts";
import { publishEvent } from "${import.meta.dir}/events.ts";
const database = createDatabase(process.env.DATABASE_URL);
await publishEvent(database.db, JSON.parse(process.env.PENDIA_EVENT ?? "{}"));
await database.close();
`,
    );
    const proc = Bun.spawn({
      cmd: [process.execPath, file],
      env: {
        ...process.env,
        DATABASE_URL: url,
        PENDIA_EVENT: JSON.stringify(event),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) throw new Error(`Publisher exited ${code}: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!databaseUrl)("api events", () => {
  test("an event published from a second process reaches the stream", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const stream = await openEvents(base, token);
        try {
          // Parking on the wake means nothing can reach the subscriber
          // through a catch-up read any more, so the next event needs NOTIFY.
          await park(db, stream);
          const event: Event = {
            kind: "library.changed",
            libraryId: Bun.randomUUIDv7(),
          };
          // The poll fallback waits five seconds, so a frame inside three
          // seconds can only have arrived through the NOTIFY wake.
          const want = stream.frames.length + 1;
          await publishFromProcess(url, event);
          await stream.waitFor(want, 3_000);
          expect(JSON.parse(stream.frames.at(-1)?.data ?? "")).toEqual(event);
        } finally {
          await stream.close();
        }
      } finally {
        await server.stop();
      }
    }));

  test("a reconnect with Last-Event-ID replays the missed events in order", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const first = await openEvents(base, token);
        let lastId: string;
        try {
          await park(db, first);
          const firstEvent: Event = {
            kind: "segment.ready",
            sessionId: Bun.randomUUIDv7(),
            index: 1,
          };
          const want = first.frames.length + 1;
          await publishEvent(db, firstEvent);
          await first.waitFor(want, 3_000);
          const frame = first.frames.at(-1);
          expect(JSON.parse(frame?.data ?? "")).toEqual(firstEvent);
          if (frame?.id === undefined)
            throw new Error("The frame carries no event id.");
          lastId = frame.id;
        } finally {
          await first.close();
        }
        const missed: Event[] = [
          { kind: "segment.ready", sessionId: Bun.randomUUIDv7(), index: 2 },
          { kind: "segment.ready", sessionId: Bun.randomUUIDv7(), index: 3 },
        ];
        for (const event of missed) await publishEvent(db, event);
        const resumed = await openEvents(base, token, lastId);
        try {
          const frames = await resumed.waitFor(2, 3_000);
          expect(frames.map((frame) => JSON.parse(frame.data))).toEqual(missed);
          const ids = frames.map((frame) => BigInt(frame.id ?? "0"));
          expect(ids[0] ?? 0n).toBeLessThan(ids[1] ?? 0n);
        } finally {
          await resumed.close();
        }
      } finally {
        await server.stop();
      }
    }));

  test("a stream without Last-Event-ID only sees events from now", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        await publishEvent(db, {
          kind: "library.changed",
          libraryId: Bun.randomUUIDv7(),
        });
        const stream = await openEvents(base, token);
        try {
          await Bun.sleep(400);
          expect(stream.frames).toHaveLength(0);
          const fresh: Event = {
            kind: "session.state",
            sessionId: Bun.randomUUIDv7(),
            state: "playing",
          };
          await publishEvent(db, fresh);
          const [frame] = await stream.waitFor(1, 3_000);
          expect(JSON.parse(frame?.data ?? "")).toEqual(fresh);
        } finally {
          await stream.close();
        }
      } finally {
        await server.stop();
      }
    }));

  test("publishEvent prunes rows past the retention window", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const [old] = await db
        .insert(events)
        .values({
          kind: "library.changed",
          payload: { kind: "library.changed", libraryId: Bun.randomUUIDv7() },
          createdAt: new Date(Date.now() - 60_000),
        })
        .returning({ id: events.id });
      if (!old) throw new Error("Event insert returned no row.");
      const freshId = await publishEvent(
        db,
        { kind: "library.changed", libraryId: Bun.randomUUIDv7() },
        { retentionSeconds: 1 },
      );
      const remaining = await db
        .select({ id: events.id })
        .from(events)
        .where(inArray(events.id, [old.id, freshId]));
      expect(remaining.map((row) => row.id)).toEqual([freshId]);
    }));

  test("each caller only receives the events it may see, live and on replay", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin } = await seed(db);
      const movies = await insertLibrary(db, "Movies");
      const shows = await insertLibrary(db, "Shows");
      const movieFan = await createLocalUser(db, admin.id, {
        username: "moviefan",
        password: "viewer-pass",
      });
      const showFan = await createLocalUser(db, admin.id, {
        username: "showfan",
        password: "viewer-pass",
      });
      await db.insert(libraryAccess).values({
        libraryId: shows.id,
        userId: movieFan.id,
        allowed: false,
      });
      await db.insert(libraryAccess).values({
        libraryId: movies.id,
        userId: showFan.id,
        allowed: false,
      });
      const { token: movieToken } = await createApiKey(db, movieFan.id, "m");
      const { token: showToken } = await createApiKey(db, showFan.id, "s");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const moviesEvent: Event = {
          kind: "library.changed",
          libraryId: movies.id,
        };
        const showsEvent: Event = {
          kind: "library.changed",
          libraryId: shows.id,
        };
        const movieStream = await openEvents(base, movieToken);
        const showStream = await openEvents(base, showToken);
        try {
          await park(db, movieStream);
          await park(db, showStream);
          const wantMovies = movieStream.frames.length + 1;
          await publishEvent(db, moviesEvent);
          await movieStream.waitFor(wantMovies, 3_000);
          const wantShows = showStream.frames.length + 1;
          await publishEvent(db, showsEvent);
          await showStream.waitFor(wantShows, 3_000);
          await Bun.sleep(400);
          expect(seen(movieStream)).toContainEqual(moviesEvent);
          expect(seen(movieStream)).not.toContainEqual(showsEvent);
          expect(seen(showStream)).toContainEqual(showsEvent);
          expect(seen(showStream)).not.toContainEqual(moviesEvent);
        } finally {
          await movieStream.close();
          await showStream.close();
        }
        // Replay applies the same audience filter to stored rows.
        const replayed = await openEvents(base, movieToken, "0");
        try {
          await replayed.waitFor(1, 3_000);
          await Bun.sleep(400);
          expect(seen(replayed)).toContainEqual(moviesEvent);
          expect(seen(replayed)).not.toContainEqual(showsEvent);
        } finally {
          await replayed.close();
        }
      } finally {
        await server.stop();
      }
    }));

  test("an admin receives job progress while a plain caller does not", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token: adminToken } = await seed(db);
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "viewer-pass",
      });
      const { token: viewerToken } = await createApiKey(
        db,
        viewer.id,
        "viewer-key",
      );
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const adminStream = await openEvents(base, adminToken);
        const viewerStream = await openEvents(base, viewerToken);
        try {
          await park(db, adminStream);
          await park(db, viewerStream);
          const progress: Event = {
            kind: "job.progress",
            jobId: Bun.randomUUIDv7(),
            state: "running",
          };
          const want = adminStream.frames.length + 1;
          await publishEvent(db, progress);
          await adminStream.waitFor(want, 3_000);
          await Bun.sleep(400);
          expect(seen(adminStream)).toContainEqual(progress);
          expect(seen(viewerStream)).not.toContainEqual(progress);
        } finally {
          await adminStream.close();
          await viewerStream.close();
        }
      } finally {
        await server.stop();
      }
    }));

  test("session events reach only the owner and admins", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { admin, token: adminToken } = await seed(db);
      const owner = await createLocalUser(db, admin.id, {
        username: "owner",
        password: "owner-pass",
      });
      const other = await createLocalUser(db, admin.id, {
        username: "other",
        password: "other-pass",
      });
      const { token: ownerToken } = await createApiKey(db, owner.id, "o");
      const { token: otherToken } = await createApiKey(db, other.id, "x");
      const library = await insertLibrary(db, "Movies");
      const [item] = await db
        .insert(items)
        .values({
          libraryId: library.id,
          kind: "movie",
          title: "Movie",
          canonicalFolder: "/srv/movies/movie",
        })
        .returning();
      if (!item) throw new Error("Item insert returned no row.");
      const [version] = await db
        .insert(versions)
        .values({
          itemId: item.id,
          itemKind: "movie",
          libraryId: library.id,
          label: "Original",
          format: "video",
          bytes: 1n,
        })
        .returning();
      if (!version) throw new Error("Version insert returned no row.");
      const [session] = await db
        .insert(sessionRegistry)
        .values({
          userId: owner.id,
          itemId: item.id,
          versionId: version.id,
          playMethod: "direct-play",
          state: "playing",
        })
        .returning();
      if (!session) throw new Error("Session insert returned no row.");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const adminStream = await openEvents(base, adminToken);
        const ownerStream = await openEvents(base, ownerToken);
        const otherStream = await openEvents(base, otherToken);
        try {
          await park(db, adminStream);
          await park(db, ownerStream);
          await park(db, otherStream);
          const playing: Event = {
            kind: "session.state",
            sessionId: session.id,
            state: "playing",
          };
          const wantAdmin = adminStream.frames.length + 1;
          const wantOwner = ownerStream.frames.length + 1;
          await publishEvent(db, playing);
          await adminStream.waitFor(wantAdmin, 3_000);
          await ownerStream.waitFor(wantOwner, 3_000);
          await Bun.sleep(400);
          expect(seen(adminStream)).toContainEqual(playing);
          expect(seen(ownerStream)).toContainEqual(playing);
          expect(seen(otherStream)).not.toContainEqual(playing);
        } finally {
          await adminStream.close();
          await ownerStream.close();
          await otherStream.close();
        }
      } finally {
        await server.stop();
      }
    }));

  test("a revoked session stops receiving events and the stream ends", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token, user, session } = await seed(db);
      const server = await startPendia("api", {
        databaseUrl: url,
        port: 0,
        brokerOptions: { pollIntervalMs: 50, revalidateIntervalMs: 100 },
      });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const stream = await openEvents(base, token);
        try {
          await park(db, stream);
          await revokeSession(db, user.id, session.id);
          const afterRevoke: Event = {
            kind: "library.changed",
            libraryId: Bun.randomUUIDv7(),
          };
          await publishEvent(db, afterRevoke);
          // The delivery-path revalidate throws and ends the generator; the
          // idle ceiling would end it without a publish.
          await stream.waitUntilEnded(3_000);
          expect(seen(stream)).not.toContainEqual(afterRevoke);
        } finally {
          await stream.close();
        }
      } finally {
        await server.stop();
      }
    }));

  test("revocation mid-batch stops delivery inside the interval", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token, user, session } = await seed(db);
      for (let index = 0; index < 3; index++) {
        await publishEvent(db, {
          kind: "library.changed",
          libraryId: Bun.randomUUIDv7(),
        });
      }
      const broker = await startEventBroker(db, {
        revalidateIntervalMs: 0,
      });
      try {
        // Driving subscribe directly keeps the revocation deterministic: the
        // batch check is call one, each row revalidates under a zero interval,
        // so call three lands before the second row authorises.
        let calls = 0;
        const stream = broker.subscribe({
          caller: await authenticate(db, token),
          lastEventId: "0",
          revalidate: async () => {
            calls++;
            if (calls === 3) await revokeSession(db, user.id, session.id);
            return authenticate(db, token);
          },
        });
        const first = await stream.next();
        expect(first.done).toBe(false);
        await expect(stream.next()).rejects.toThrow();
        expect((await stream.next()).done).toBe(true);
      } finally {
        await broker.stop();
      }
    }));

  test("an unauthenticated request to the stream answers 401", () =>
    withDatabase(async (_db, url) => {
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const response = await fetch(`${base}/api/events`);
        expect(response.status).toBe(401);
        await response.body?.cancel();
      } finally {
        await server.stop();
      }
    }));

  test("stop resolves while an event stream is open", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      const base = `http://127.0.0.1:${server.apiServer?.port}`;
      const stream = await openEvents(base, token);
      // The broker must stop before the server's graceful stop: an open
      // stream is an in-flight response that only ends once the broker
      // wakes its waiters, so stopping the server first waits forever.
      const stopped = await Promise.race([
        server.stop().then(() => true),
        Bun.sleep(3_000).then(() => false),
      ]);
      await stream.close();
      expect(stopped).toBe(true);
    }));
});
