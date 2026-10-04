import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { libraries } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { fetchPlugin, installPlugin } from "./install.ts";
import { createPluginRuntime, type PluginRuntime } from "./runtime.ts";
import { updatePluginState } from "./settings.ts";
import { withFolder } from "./testing.ts";

const webhooksRoot = join(import.meta.dir, "../../../../plugins/webhooks");
const webhooksName = "@pendia/plugin-webhooks";

/** Bundles the in-repo webhooks plugin into `folder` as its published package: package.json and dist. */
export async function packWebhooks(folder: string): Promise<string> {
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

describe.skipIf(!databaseUrl)("webhooks plugin", () => {
  test("an added Item posts the rendered body, retrying a 5xx answer", () =>
    withFolder((folder) =>
      withDatabase(async (db) => {
        const received: { method: string; headers: Headers; body: string }[] =
          [];
        using receiver = Bun.serve({
          port: 0,
          async fetch(request) {
            received.push({
              method: request.method,
              headers: request.headers,
              body: await request.text(),
            });
            return new Response(null, {
              status: received.length === 1 ? 503 : 204,
            });
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
            url: `${receiver.url}hooks`,
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
        await runPluginJobs(db, runtime);

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
        expect(await runtime.load(webhooksName)).toBe(true);
        await runtime.stop();
      }),
    ));
});
