import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { homeShelves } from "../api/browse.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, jobs, settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { insertLibraries } from "../libraries/testing.ts";
import { registerMetadataJobs } from "../metadata/jobs.ts";
import { createPluginRouteHandler } from "./http.ts";
import { createPluginRuntime, enqueueTick } from "./runtime.ts";
import { readPluginSettings } from "./settings.ts";
import { type FixturePlugin, installFixture, withFolder } from "./testing.ts";

declare global {
  var thaliaCalls: unknown[] | undefined;
}

/** A fixture entry that records calls on globalThis.thaliaCalls. */
function recording(body: string) {
  return `const record = (value) => { (globalThis.thaliaCalls ??= []).push(value); };
export default (host) => { ${body} };`;
}

async function seed(db: Database, folder: string, plugin: FixturePlugin) {
  await migrateDatabase(db);
  globalThis.thaliaCalls = [];
  await installFixture(db, folder, plugin);
  const [library] = await insertLibraries(db, {
    name: "Movies",
    medium: "movies",
    rootPath: folder,
  });
  if (!library) throw new Error("Library missing.");
  const item = await insertItem(db, {
    libraryId: library.id,
    kind: "movie",
    title: "Alien",
    year: 1979,
    canonicalFolder: "Alien (1979)",
    extension: {},
  });
  const runtime = createPluginRuntime(db, {
    directory: join(folder, "installed"),
    schedules: true,
  });
  return { item, runtime };
}

async function runPluginJobs(
  db: Database,
  runtime: ReturnType<typeof createPluginRuntime>,
) {
  const queue = createJobQueue(db);
  for (;;) {
    const job = await queue.claim(["plugin"]);
    if (job === undefined) return;
    if (job.payload.type === "plugin") await runtime.runJob(job.payload);
    await queue.complete(job);
  }
}

describe.skipIf(!databaseUrl)("plugin bridges", () => {
  test("a provider registered by a plugin takes part in matching", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const { item, runtime } = await seed(db, folder, {
          name: "thalia-plugin-catalog",
          capabilities: ["providers"],
          source: `export default (host) => host.providers.metadata({
  id: "catalog",
  kinds: ["movie"],
  search: async ({ title }) => [{ providerId: "c-1", title, year: 1979, confidence: 1 }],
  fetch: async () => ({
    title: "Alien (Catalog)",
    overview: "In space.",
    year: 1979,
    contentRating: null,
    genres: ["Horror"],
    credits: [],
    artwork: [],
    providerIds: {},
  }),
});`,
        });
        await db
          .insert(settings)
          .values({ key: "metadata", value: { providerOrder: ["catalog"] } });
        const registry = createJobRegistry();
        registerMetadataJobs(db, registry, fetch, runtime);
        const job = await createJobQueue(db).enqueue({
          type: "provider-fetch",
          itemId: item.id,
        });
        await registry.run(job);
        const [matched] = await db
          .select()
          .from(items)
          .where(eq(items.id, item.id));
        expect(matched).toMatchObject({
          title: "Alien (Catalog)",
          overview: "In space.",
          metadataState: "matched",
        });
      }),
    ));

  test("an event reaches a plugin once, through the queue", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const { runtime } = await seed(db, folder, {
          name: "thalia-plugin-listener",
          capabilities: ["events"],
          source: recording(
            'host.events.on("item.added", async (payload) => record(payload));',
          ),
        });
        // The plugin installs before the seed adds its item, so item.added is queued.
        await runPluginJobs(db, runtime);
        expect(globalThis.thaliaCalls).toEqual([
          { itemId: expect.any(String), kind: "movie" },
        ]);
        await runPluginJobs(db, runtime);
        expect(globalThis.thaliaCalls).toHaveLength(1);
      }),
    ));

  test("a schedule tick enqueues one deduplicated job that runs the handler", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const name = "thalia-plugin-cron";
        const { runtime } = await seed(db, folder, {
          name,
          capabilities: ["jobs"],
          source: recording(
            'host.jobs.schedule("sweep", "* * * * *", async () => record("swept"));',
          ),
        });
        expect(await runtime.load(name)).toBe(true);
        const at = new Date("2026-10-04T12:00:05Z");
        await enqueueTick(db, name, "sweep", at);
        await enqueueTick(db, name, "sweep", new Date("2026-10-04T12:00:40Z"));
        expect(
          await db.select().from(jobs).where(eq(jobs.type, "plugin")),
        ).toHaveLength(1);
        await runPluginJobs(db, runtime);
        expect(globalThis.thaliaCalls).toEqual(["swept"]);
        await runtime.stop();
      }),
    ));

  test("a route answers under the plugin prefix, and a throwing route fails only its plugin", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const name = "@thalia/plugin-route";
        const { runtime } = await seed(db, folder, {
          name,
          capabilities: ["http"],
          source: recording(`
host.http.route("GET", "/hello", async (request) => ({ status: 200, body: { userId: request.userId, query: request.query } }));
host.http.route("POST", "/boom", async () => { throw new Error("route boom"); });`),
        });
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const { token } = await createApiKey(db, admin.id, "routes");
        const handle = createPluginRouteHandler(db, runtime);
        const hello = await handle(
          new Request(
            "http://thalia.test/plugins/@thalia/plugin-route/hello?x=1",
            {
              headers: { authorization: `Bearer ${token}` },
            },
          ),
          "127.0.0.1",
        );
        expect(hello?.status).toBe(200);
        expect(await hello?.json()).toEqual({
          userId: admin.id,
          query: { x: "1" },
        });
        const anonymous = await handle(
          new Request("http://thalia.test/plugins/@thalia/plugin-route/hello"),
          "127.0.0.1",
        );
        expect(await anonymous?.json()).toMatchObject({ userId: null });
        expect(
          await handle(new Request("http://thalia.test/api/me"), "127.0.0.1"),
        ).toBeUndefined();

        const boom = await handle(
          new Request("http://thalia.test/plugins/@thalia/plugin-route/boom", {
            method: "POST",
          }),
          "127.0.0.1",
        );
        expect(boom?.status).toBe(500);
        expect((await readPluginSettings(db)).plugins[name]).toMatchObject({
          enabled: false,
          failure: { message: "route boom" },
        });
        const after = await handle(
          new Request("http://thalia.test/plugins/@thalia/plugin-route/hello"),
          "127.0.0.1",
        );
        expect(after?.status).toBe(404);
      }),
    ));

  test("a plugin shelf joins Home with the items the user may view", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const { item, runtime } = await seed(db, folder, {
          name: "thalia-plugin-shelf",
          capabilities: ["shelves", "items:read"],
          source: `export default (host) => host.shelves.register({
  id: "leaving-soon",
  title: "Leaving soon",
  placement: "home",
  items: async () => {
    const { items } = await host.items.query({ kind: ["movie"] });
    return [...items.map((item) => item.id), "not-a-uuid"];
  },
});`,
        });
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const shelves = await homeShelves(db, admin.id, runtime);
        const shelf = shelves.find(
          (candidate) => candidate.id === "thalia-plugin-shelf:leaving-soon",
        );
        expect(shelf?.title).toBe("Leaving soon");
        expect(shelf?.entries.map((entry) => entry.item.id)).toEqual([item.id]);
      }),
    ));
});
