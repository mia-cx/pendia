import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase, migrationLockKey } from "./db/migrate.ts";
import {
  groups,
  type JobPayload,
  type TranscoderBackend,
  transcoderCapabilities,
} from "./db/schema/index.ts";
import { databaseUrl, withDatabase } from "./db/testing.ts";
import { type Role, startThalia } from "./index.ts";
import { createJobQueue, type Job, listJobs } from "./jobs/queue.ts";
import { createJobRegistry } from "./jobs/registry.ts";
import { startTranscoder } from "./transcoder/index.ts";

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
      const server = await startThalia("worker", {
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

  // Tests that run the real startup trial need more than Bun's default 5 s.
  test(
    "all role migrates, serves readiness and runs jobs",
    () =>
      withDatabase(async (db, url) => {
        const seen: string[] = [];
        const registry = createJobRegistry();
        registry.register("probe", async (payload) => {
          seen.push(payload.fileId);
        });
        const server = await startThalia("all", {
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
      }),
    30_000,
  );

  test("the api answers readiness only after migrations and the startup trial", () =>
    withDatabase(async (db, url) => {
      // Holding the migration lock parks startup before the schema exists.
      const lock = await db.$client.reserve();
      await lock`select pg_advisory_lock(${migrationLockKey})`;
      let locked = true;
      const unlock = async () => {
        if (!locked) return;
        locked = false;
        await lock`select pg_advisory_unlock(${migrationLockKey})`;
        lock.release();
      };
      // The port must be known while startThalia is still starting.
      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = probe.port;
      await probe.stop();
      const readiness = () =>
        fetch(`http://127.0.0.1:${port}/readyz`).then(
          (response) => response.status,
          () => "no answer",
        );
      const table: TranscoderBackend[] = [
        { name: "cpu", codecs: ["h264"], toneMapping: ["hdr10"] },
      ];
      let trialCalled = false;
      let startTrial: () => void = () => {};
      const trialStarted = new Promise<void>((resolve) => {
        startTrial = resolve;
      });
      let finishTrial: (backends: TranscoderBackend[]) => void = () => {};
      const starting = startThalia("all", {
        databaseUrl: url,
        port,
        transcoderOptions: {
          port: 0,
          trial: () => {
            trialCalled = true;
            startTrial();
            return new Promise((resolve) => {
              finishTrial = resolve;
            });
          },
        },
      });
      try {
        await Bun.sleep(200);
        expect(trialCalled).toBe(false);
        expect(await readiness()).toBe("no answer");

        await unlock();
        await trialStarted;
        // Migrations finished: they seed the built-in groups.
        expect(await db.select().from(groups)).toHaveLength(2);
        expect(await readiness()).toBe("no answer");

        finishTrial(table);
        await starting;
        expect(await readiness()).toBe(200);
      } finally {
        await unlock();
        finishTrial(table);
        await (await starting.catch(() => null))?.stop();
      }
    }));

  test(
    "transcoder role registers its node, answers the internal route and unregisters on stop",
    () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const server = await startThalia("transcoder", {
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
            { id: transcoder.nodeId, address: transcoder.address },
          ]);
          // The real startup trial ran: the CPU comes first and encodes H.264.
          expect(nodes[0]?.backends[0]?.name).toBe("cpu");
          expect(nodes[0]?.backends[0]?.codecs).toContain("h264");
          expect(transcoder.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

          const health = await fetch(`${transcoder.address}/healthz`);
          expect(health.status).toBe(200);

          const ready = await fetch(`${transcoder.address}/readyz`);
          expect(ready.status).toBe(200);
          expect(await ready.json()).toMatchObject({ status: "ready" });

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
      }),
    30_000,
  );

  test(
    "a transcoder without a database answer reports not ready",
    () =>
      withDatabase(async (db) => {
        await migrateDatabase(db);
        const scratchDir = await mkdtemp(join(tmpdir(), "thalia-readyz-"));
        const transcoder = await startTranscoder(db, {
          port: 0,
          scratchDir,
          ready: async () => false,
        });
        try {
          const ready = await fetch(`${transcoder.address}/readyz`);
          expect(ready.status).toBe(503);
          expect(await ready.json()).toMatchObject({
            status: "database unavailable",
          });
        } finally {
          await transcoder.stop();
          await rm(scratchDir, { recursive: true, force: true });
        }
      }),
    30_000,
  );

  test("readiness waits for the startup trial and the node row carries its table", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const scratchDir = await mkdtemp(join(tmpdir(), "thalia-trial-"));
      // The port must be known while startTranscoder is still awaiting the trial.
      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = probe.port;
      await probe.stop();
      const table: TranscoderBackend[] = [
        { name: "cpu", codecs: ["h264"], toneMapping: ["hdr10"] },
      ];
      let finishTrial: (backends: TranscoderBackend[]) => void = () => {};
      const starting = startTranscoder(db, {
        port,
        scratchDir,
        trial: () =>
          new Promise((resolve) => {
            finishTrial = resolve;
          }),
      });
      try {
        const base = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + 2_000;
        while ((await fetch(`${base}/healthz`).catch(() => null)) === null) {
          if (Date.now() > deadline) throw new Error("No /healthz answer.");
          await Bun.sleep(10);
        }
        const early = await fetch(`${base}/readyz`);
        expect(early.status).toBe(503);
        expect(await early.json()).toMatchObject({ status: "starting" });
        expect(await db.select().from(transcoderCapabilities)).toHaveLength(0);

        finishTrial(table);
        const transcoder = await starting;
        expect((await fetch(`${base}/readyz`)).status).toBe(200);
        const [node] = await db.select().from(transcoderCapabilities);
        expect(node).toMatchObject({ id: transcoder.nodeId, backends: table });
      } finally {
        finishTrial(table);
        await (await starting.catch(() => null))?.stop();
        await rm(scratchDir, { recursive: true, force: true });
      }
    }));

  test("a failed startup trial stops the transcoder before it registers", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const scratchDir = await mkdtemp(join(tmpdir(), "thalia-trial-"));
      try {
        await expect(
          startTranscoder(db, {
            port: 0,
            scratchDir,
            trial: async () => {
              throw new Error("The CPU trial encoded no codec.");
            },
          }),
        ).rejects.toThrow("The CPU trial encoded no codec.");
        expect(await db.select().from(transcoderCapabilities)).toHaveLength(0);
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    }));

  test(
    "a trailing slash on the transcoder address is stripped",
    () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const server = await startThalia("transcoder", {
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
      }),
    30_000,
  );

  for (const role of [
    "api",
    "transcoder",
    "watcher",
  ] as const satisfies Role[]) {
    test(
      `${role} role leaves registered jobs queued`,
      () =>
        withDatabase(async (db, url) => {
          await migrateDatabase(db);
          let calls = 0;
          const registry = createJobRegistry();
          registry.register("probe", async () => {
            calls++;
          });
          const queue = createJobQueue(db);
          const job = await queue.enqueue(probePayload());
          const server = await startThalia(role, {
            databaseUrl: url,
            port: 0,
            registry,
            workerOptions: { pollIntervalMs: 20 },
            transcoderOptions: { port: 0 },
            watcherConfig: {
              apiUrl: new URL("http://127.0.0.1:9"),
              token: "unused",
              roots: new Map(),
            },
            watcherOptions: { onError: () => {} },
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
        }),
      role === "transcoder" ? 30_000 : undefined,
    );
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
      const server = await startThalia("worker", {
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
