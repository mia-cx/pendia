import { describe, expect, test } from "bun:test";
import { migrateDatabase } from "./db/migrate.ts";
import { type JobPayload, transcoderCapabilities } from "./db/schema/index.ts";
import { databaseUrl, withDatabase } from "./db/testing.ts";
import { type Role, startPendia } from "./index.ts";
import { createJobQueue, type Job, listJobs } from "./jobs/queue.ts";
import { createJobRegistry } from "./jobs/registry.ts";

function probePayload(): Extract<JobPayload, { type: "probe" }> {
  return { type: "probe", fileId: Bun.randomUUIDv7() };
}

async function waitForJobState(
  db: Parameters<typeof listJobs>[0],
  id: string,
  state: Job["state"],
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = (await listJobs(db)).find((row) => row.id === id);
    if (job?.state === state) return job;
    await Bun.sleep(10);
  }
  throw new Error(`Job ${id} did not reach state ${state}.`);
}

describe.skipIf(!databaseUrl)("Role startup", () => {
  test("worker role runs registered handlers without an API server", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const seen: string[] = [];
      const registry = createJobRegistry();
      registry.register("probe", async (payload) => {
        seen.push(payload.fileId);
      });
      const queue = createJobQueue(db);
      const payload = probePayload();
      const job = await queue.enqueue(payload);
      const server = await startPendia("worker", {
        databaseUrl: url,
        registry,
        workerOptions: { pollIntervalMs: 20 },
      });
      try {
        expect(server.apiServer).toBeUndefined();
        await waitForJobState(db, job.id, "completed");
        expect(seen).toEqual([payload.fileId]);
      } finally {
        await server.stop();
      }
    }));

  test("all role migrates, serves readiness and runs jobs", () =>
    withDatabase(async (db, url) => {
      const seen: string[] = [];
      const registry = createJobRegistry();
      registry.register("probe", async (payload) => {
        seen.push(payload.fileId);
      });
      const server = await startPendia("all", {
        databaseUrl: url,
        port: 0,
        registry,
        workerOptions: { pollIntervalMs: 20 },
        transcoderOptions: { port: 0 },
      });
      try {
        expect(server.transcoder).toBeDefined();
        const nodes = await db.select().from(transcoderCapabilities);
        expect(nodes).toMatchObject([{ id: server.transcoder?.nodeId }]);
        const ready = await fetch(
          `http://127.0.0.1:${server.apiServer?.port}/readyz`,
        );
        expect(ready.status).toBe(200);
        const queue = createJobQueue(db);
        const payload = probePayload();
        const job = await queue.enqueue(payload);
        await waitForJobState(db, job.id, "completed");
        expect(seen).toEqual([payload.fileId]);
      } finally {
        await server.stop();
      }
    }));

  test("transcoder role registers its node, answers the internal route and unregisters on stop", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const server = await startPendia("transcoder", {
        databaseUrl: url,
        transcoderOptions: { port: 0 },
      });
      try {
        const transcoder = server.transcoder;
        if (transcoder === undefined) {
          throw new Error("Expected a transcoder handle.");
        }
        const nodes = await db.select().from(transcoderCapabilities);
        expect(nodes).toMatchObject([
          { id: transcoder.nodeId, address: transcoder.address, backends: [] },
        ]);
        expect(transcoder.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        const health = await fetch(`${transcoder.address}/healthz`);
        expect(health.status).toBe(200);

        const scope = `${transcoder.address}/internal/playback/${Bun.randomUUIDv7()}/${Bun.randomUUIDv7()}/hls`;
        const badToken = await fetch(`${scope}/master.m3u8?token=bad`);
        expect(badToken.status).toBe(401);
        expect(await badToken.json()).toMatchObject({
          error: { code: "UNAUTHENTICATED" },
        });
        expect((await fetch(`${scope}/master.m3u8`)).status).toBe(401);
        expect(
          (
            await fetch(`${scope}/master.m3u8?token=bad`, {
              method: "POST",
            })
          ).status,
        ).toBe(405);
        expect((await fetch(`${scope}/evil.txt?token=x`)).status).toBe(404);
      } finally {
        await server.stop();
      }
      expect(await db.select().from(transcoderCapabilities)).toHaveLength(0);
      await expect(
        fetch(`http://127.0.0.1:${server.transcoder?.port}/healthz`),
      ).rejects.toThrow();
    }));

  test("a trailing slash on the transcoder address is stripped", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const server = await startPendia("transcoder", {
        databaseUrl: url,
        transcoderOptions: { port: 0, address: "http://127.0.0.1:9/" },
      });
      try {
        expect(server.transcoder?.address).toBe("http://127.0.0.1:9");
        const [node] = await db
          .select({ address: transcoderCapabilities.address })
          .from(transcoderCapabilities);
        expect(node?.address).toBe("http://127.0.0.1:9");
      } finally {
        await server.stop();
      }
    }));

  for (const role of [
    "api",
    "transcoder",
    "watcher",
  ] as const satisfies Role[]) {
    test(`${role} role leaves registered jobs queued`, () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        let calls = 0;
        const registry = createJobRegistry();
        registry.register("probe", async () => {
          calls++;
        });
        const queue = createJobQueue(db);
        const job = await queue.enqueue(probePayload());
        const server = await startPendia(role, {
          databaseUrl: url,
          port: 0,
          registry,
          workerOptions: { pollIntervalMs: 20 },
          transcoderOptions: { port: 0 },
        });
        try {
          await Bun.sleep(100);
          expect(calls).toBe(0);
          expect(await listJobs(db, { state: "queued" })).toMatchObject([
            { id: job.id, attempts: 0 },
          ]);
        } finally {
          await server.stop();
        }
      }));
  }

  test("stop drains an active handler before closing", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const registry = createJobRegistry();
      registry.register("probe", async () => {
        entered.resolve();
        await release.promise;
      });
      const queue = createJobQueue(db);
      const job = await queue.enqueue(probePayload());
      const server = await startPendia("worker", {
        databaseUrl: url,
        registry,
        workerOptions: { concurrency: 1, pollIntervalMs: 20 },
      });
      try {
        await entered.promise;
        let stopped = false;
        const stopping = server.stop().then(() => {
          stopped = true;
        });
        await Bun.sleep(20);
        expect(stopped).toBe(false);
        release.resolve();
        await stopping;
        await server.stop();
        expect((await listJobs(db))[0]).toMatchObject({
          id: job.id,
          state: "completed",
          attempts: 1,
        });
      } finally {
        release.resolve();
        await server.stop();
      }
    }));
});
