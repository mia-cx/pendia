import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { fetchPlugin, installPlugin } from "./install.ts";
import { readRegistry } from "./registries.ts";
import { createPluginRuntime, type PluginRuntime } from "./runtime.ts";
import { updatePluginState } from "./settings.ts";
import { withFolder } from "./testing.ts";

const repoRoot = join(import.meta.dir, "../../../..");
const webhooksRoot = join(repoRoot, "plugins/webhooks");
const webhooksName = "@pendia/plugin-webhooks";

/** Bundles the in-repo webhooks plugin into `folder` as its published package: package.json and dist. */
async function packWebhooks(folder: string): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(webhooksRoot, "src/index.ts")],
    target: "bun",
  });
  const [entry] = build.outputs;
  if (!build.success || entry === undefined)
    throw new AggregateError(build.logs, "The webhooks bundle failed.");
  await Bun.write(join(folder, "dist/index.js"), await entry.text());
  await Bun.write(
    join(folder, "package.json"),
    Bun.file(join(webhooksRoot, "package.json")),
  );
  return folder;
}

async function runPluginJobs(db: Database, runtime: PluginRuntime) {
  const queue = createJobQueue(db);
  for (;;) {
    const job = await queue.claim(["plugin"]);
    if (job === undefined) return;
    if (job.payload.type === "plugin") await runtime.runJob(job.payload);
    await queue.complete(job);
  }
}

type Received = { method: string; headers: Headers; body: string };

/**
 * Installs the bundled plugin, adds an Item and delivers its item.added event
 * to a local receiver that answers each request with `status(n)`. Resolves
 * what the receiver got and what the plugin logged.
 */
async function deliverAddedItem(
  db: Database,
  folder: string,
  status: (request: number) => number,
) {
  const received: Received[] = [];
  using receiver = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      return new Response(null, { status: status(received.length) });
    },
  });
  await migrateDatabase(db);
  const source = await packWebhooks(join(folder, "source"));
  const { integrity } = await fetchPlugin(source);
  const directory = join(folder, "installed");
  await installPlugin(db, directory, source, integrity);
  await updatePluginState(db, webhooksName, (state) => ({
    ...state,
    config: {
      url: `${receiver.url}hooks/secret-token`,
      headers: ["X-Token: s3cret"],
      body: '{"text":"Added {{item.title}} ({{item.year}})","kind":"{{data.kind}}"}',
    },
  }));
  const [library] = await db
    .insert(libraries)
    .values({ name: "Movies", medium: "movies", rootPath: folder })
    .returning();
  if (!library) throw new Error("Library missing.");
  await insertItem(db, {
    libraryId: library.id,
    kind: "movie",
    title: 'The "Thing"',
    year: 1982,
    canonicalFolder: "The Thing (1982)",
    extension: {},
  });

  const runtime = createPluginRuntime(db, { directory });
  const logged = spyOn(console, "log");
  try {
    await runPluginJobs(db, runtime);
    const lines = logged.mock.calls.map(([line]) => String(line));
    const loaded = await runtime.load(webhooksName);
    return { received, lines, loaded };
  } finally {
    logged.mockRestore();
    await runtime.stop();
  }
}

describe.skipIf(!databaseUrl)("webhooks plugin", () => {
  test("an added Item posts the rendered body, retrying a 5xx answer", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const { received, lines, loaded } = await deliverAddedItem(
          db,
          folder,
          (request) => (request === 1 ? 503 : 204),
        );
        expect(received).toHaveLength(2);
        for (const request of received) {
          expect(request.method).toBe("POST");
          expect(request.headers.get("x-token")).toBe("s3cret");
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(JSON.parse(request.body)).toEqual({
            text: 'Added The "Thing" (1982)',
            kind: "movie",
          });
        }
        // The 503 is logged by origin; the path's token stays out of the log.
        expect(lines.some((line) => line.includes("webhook.rejected"))).toBe(
          true,
        );
        expect(lines.some((line) => line.includes("secret-token"))).toBe(false);
        expect(loaded).toBe(true);
      }),
    ));

  test("a redirect is logged as not delivered and not retried", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const { received, lines } = await deliverAddedItem(
          db,
          folder,
          () => 307,
        );
        expect(received).toHaveLength(1);
        expect(
          lines.filter(
            (line) =>
              line.includes("webhook.rejected") &&
              line.includes('"status":307'),
          ),
        ).toHaveLength(1);
      }),
    ));

  test("the official registry lists the webhooks plugin, which installs through the host", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const entries = readRegistry(
          await Bun.file(join(repoRoot, "pendia-registry.json")).json(),
        );
        const entry = entries.find((plugin) => plugin.name === webhooksName);
        const { version } = await Bun.file(
          join(webhooksRoot, "package.json"),
        ).json();
        expect(entry?.versions[0]).toEqual({
          version,
          source: `${webhooksName}@${version}`,
        });

        // A local npm stand-in serves the bundle as the published tarball.
        const packed = await packWebhooks(join(folder, "source"));
        const tarball = await new Bun.Archive(
          {
            "package/package.json": await Bun.file(
              join(packed, "package.json"),
            ).text(),
            "package/dist/index.js": await Bun.file(
              join(packed, "dist/index.js"),
            ).text(),
          },
          { compress: "gzip" },
        ).bytes();
        using npm = Bun.serve({
          port: 0,
          fetch(request) {
            const { origin, pathname } = new URL(request.url);
            const path = decodeURIComponent(pathname);
            if (path === "/webhooks.tgz") return new Response(tarball);
            if (path !== `/${webhooksName}`)
              return new Response(null, { status: 404 });
            return Response.json({
              "dist-tags": { latest: version },
              versions: {
                [version]: { dist: { tarball: `${origin}/webhooks.tgz` } },
              },
            });
          },
        });
        await migrateDatabase(db);
        const runtime = createPluginRuntime(db, {
          directory: join(folder, "installed"),
          sourceOptions: { npmRegistry: npm.url.href },
        });
        const source = entry?.versions[0]?.source ?? "";
        const preview = await runtime.preview(source);
        expect(preview.package.manifest).toMatchObject({
          capabilities: ["events", "items:read", "network"],
          network: ["*"],
        });
        await runtime.install(source, preview.integrity);
        expect(await runtime.load(webhooksName)).toBe(true);
        await runtime.stop();
      }),
    ));
});
