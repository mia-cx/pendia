import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, jobs, providerIds, settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { startPendia } from "../index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { registerMetadataJobs } from "../metadata/jobs.ts";
import { tvdbResponse } from "../metadata/tvdb-fixtures.ts";
import type { pendiaRouter } from "./router.ts";

function rpcClient(base: string, token: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof pendiaRouter>>(link);
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error.code;
    throw error;
  }
  throw new Error("Expected the client call to reject.");
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP4y8CAFWEXHbQSAPZwP0G2GkFNAAAAAElFTkSuQmCC",
  "base64",
);

describe.skipIf(!databaseUrl)("items.refresh", () => {
  test("queues one Show fetch ahead of background work and re-fetches it", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const root = await mkdtemp(join(tmpdir(), "pendia-refresh-"));
      try {
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const viewer = await createLocalUser(db, admin.id, {
          username: "viewer",
          password: "viewer-pass",
        });
        const { token: adminToken } = await createApiKey(db, admin.id, "a");
        const { token: viewerToken } = await createApiKey(db, viewer.id, "v");
        const [library] = await insertLibraries(db, {
          name: "Shows",
          medium: "shows",
          rootPath: root,
        });
        if (!library) throw new Error("Fixture library missing.");
        const show = await insertItem(db, {
          libraryId: library.id,
          kind: "show",
          title: "Stale Title",
          canonicalFolder: "Breaking Bad",
          extension: {},
        });
        await mkdir(join(root, "Breaking Bad"));
        await db
          .insert(providerIds)
          .values({ provider: "tvdb", value: "81189", itemId: show.id });
        await db
          .update(items)
          .set({ metadataState: "matched" })
          .where(eq(items.id, show.id));
        await db.insert(settings).values({
          key: "providers",
          value: { keys: { tvdb: "tvdb-key" } },
        });
        // A background fetch already due coalesces with the refresh.
        const background = await createJobQueue(db).enqueue(
          { type: "provider-fetch", itemId: show.id },
          { concurrencyKey: `provider:${show.id}` },
        );

        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = rpcClient(base, adminToken);
          const { jobId } = await client.items.refresh({ id: show.id });
          expect(jobId).toBe(background.id);
          const response = await fetch(`${base}/api/items/${show.id}/refresh`, {
            method: "POST",
            headers: { authorization: `Bearer ${adminToken}` },
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ jobId });
          expect(
            await rejection(
              rpcClient(base, viewerToken).items.refresh({ id: show.id }),
            ),
          ).toBe("FORBIDDEN");
          expect(
            await rejection(client.items.refresh({ id: Bun.randomUUIDv7() })),
          ).toBe("NOT_FOUND");
        } finally {
          await server.stop();
        }

        const [queued, ...rest] = await db
          .select()
          .from(jobs)
          .where(eq(jobs.type, "provider-fetch"));
        expect(rest).toHaveLength(0);
        expect(queued).toMatchObject({ id: background.id, priority: 1 });

        const registry = createJobRegistry();
        registerMetadataJobs(db, registry, (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const target = new URL(String(input));
          return target.hostname === "api4.thetvdb.com"
            ? tvdbResponse(target, init)
            : new Response(png);
        }) as typeof fetch);
        const queue = createJobQueue(db);
        const claimed = await queue.claim(["provider-fetch"]);
        if (!claimed) throw new Error("Refresh job was not claimed.");
        await registry.run(claimed);
        const [refreshed] = await db
          .select()
          .from(items)
          .where(eq(items.id, show.id));
        expect(refreshed).toMatchObject({
          title: "Breaking Bad",
          metadataState: "matched",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }));
});
