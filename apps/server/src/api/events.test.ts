import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { events } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { type Event, publishEvent } from "./events.ts";

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
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const frame = parseFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (frame !== undefined) frames.push(frame);
        split = buffer.indexOf("\n\n");
      }
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
    async close() {
      await reader.cancel();
      await pumping;
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

async function seed(db: Database) {
  await setupAdmin(db, { username: "admin", password: "admin-pass" });
  const { token } = await login(
    db,
    { username: "admin", password: "admin-pass", ...device },
    "127.0.0.1",
  );
  return { token };
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
        // Cursor zero replays every row, so the test does not race the
        // subscriber's initial position read against the publish.
        const stream = await openEvents(base, token, "0");
        try {
          const event: Event = {
            kind: "library.changed",
            libraryId: Bun.randomUUIDv7(),
          };
          // The poll fallback waits five seconds, so a frame inside three
          // seconds can only have arrived through the NOTIFY wake.
          await publishFromProcess(url, event);
          const [frame] = await stream.waitFor(1, 3_000);
          expect(JSON.parse(frame?.data ?? "")).toEqual(event);
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
        const first = await openEvents(base, token, "0");
        let lastId: string;
        try {
          const firstEvent: Event = {
            kind: "segment.ready",
            sessionId: Bun.randomUUIDv7(),
            index: 1,
          };
          await publishEvent(db, firstEvent);
          const [frame] = await first.waitFor(1, 3_000);
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
});
