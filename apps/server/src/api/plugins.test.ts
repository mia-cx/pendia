import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { createPendiaClient } from "../../../web/src/lib/api.ts";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { officialRegistry } from "../plugins/settings.ts";
import {
  type FixturePlugin,
  fixtureTarball,
  withFolder,
  writeFixture,
} from "../plugins/testing.ts";

const greeter: FixturePlugin = {
  name: "pendia-plugin-greeter",
  capabilities: ["http", "files"],
  config: {
    type: "object",
    required: ["greeting"],
    properties: {
      greeting: { type: "string", title: "Greeting" },
      loud: { type: "boolean", default: false },
    },
  },
  source: `export default (host) => {
  host.http.route("GET", "/hello", async () => ({ status: 200, body: await host.config.get() }));
  host.http.route("GET", "/boom", async () => { throw new Error("greeter broke"); });
};`,
};

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  return {
    admin: (await createApiKey(db, admin.id, "plugins")).token,
    viewer: (await createApiKey(db, viewer.id, "plugins")).token,
  };
}

async function withServer(
  url: string,
  directory: string,
  run: (
    base: string,
    client: (token: string) => ReturnType<typeof createPendiaClient>,
  ) => Promise<void>,
) {
  const server = await startPendia("api", {
    databaseUrl: url,
    port: 0,
    pluginOptions: { directory },
  });
  try {
    const base = `http://127.0.0.1:${server.apiServer?.port}`;
    await run(base, (token) =>
      createPendiaClient({
        origin: base,
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  } finally {
    await server.stop();
  }
}

async function capture(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw error;
  }
  throw new Error("Expected the client call to reject.");
}

describe.skipIf(!databaseUrl)("plugin admin api", () => {
  test("an admin previews, installs, configures and switches a plugin; a viewer may not", () =>
    withFolder((folder) =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const tokens = await seed(db);
        const source = await writeFixture(join(folder, "greeter"), greeter);
        await withServer(url, join(folder, "a"), async (base, client) => {
          const admin = client(tokens.admin);
          expect(
            (await capture(client(tokens.viewer).plugins.list())).code,
          ).toBe("FORBIDDEN");

          const preview = await admin.plugins.preview({ source });
          expect(preview).toMatchObject({
            source,
            name: "pendia-plugin-greeter",
            version: "1.0.0",
            capabilities: ["http", "files"],
            installedVersion: null,
          });
          const installed = await admin.plugins.install({
            source,
            integrity: preview.integrity,
          });
          expect(installed.plugins).toEqual([
            expect.objectContaining({
              name: "pendia-plugin-greeter",
              enabled: true,
              failure: null,
              filesOff: null,
              config: { loud: false },
              configFields: [
                {
                  key: "greeting",
                  type: "string",
                  title: "Greeting",
                  description: null,
                  required: true,
                  options: null,
                },
                expect.objectContaining({ key: "loud", required: false }),
              ],
            }),
          ]);

          const invalid = await capture(
            admin.plugins.setConfig({
              name: "pendia-plugin-greeter",
              config: { loud: "yes" },
            }),
          );
          expect(invalid.code).toBe("BAD_REQUEST");
          expect(invalid.message).toBe(
            "config.greeting is required. config.loud must be boolean.",
          );
          await admin.plugins.setConfig({
            name: "pendia-plugin-greeter",
            config: { greeting: "hi" },
          });
          const hello = await fetch(
            `${base}/plugins/pendia-plugin-greeter/hello`,
          );
          expect(await hello.json()).toEqual({ greeting: "hi", loud: false });

          const switched = await admin.plugins.setFiles({
            off: { until: null },
          });
          expect(switched.filesOff).toEqual({ until: null });
          const until = new Date(Date.now() + 3_600_000).toISOString();
          const own = await admin.plugins.setFiles({
            name: "pendia-plugin-greeter",
            off: { until },
          });
          expect(own.plugins[0]?.filesOff).toEqual({ until });
        });
      }),
    ));

  test("a throwing plugin is disabled while the api keeps answering, and a fresh process reinstalls from the lockfile", () =>
    withFolder((folder) =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const tokens = await seed(db);
        const tarball = await fixtureTarball(greeter);
        const packages = Bun.serve({
          port: 0,
          fetch: () => new Response(tarball),
        });
        const source = `http://127.0.0.1:${packages.port}/greeter.tgz`;
        try {
          await withServer(url, join(folder, "first"), async (base, client) => {
            const admin = client(tokens.admin);
            const { integrity } = await admin.plugins.preview({ source });
            await admin.plugins.install({ source, integrity });
            const boom = await fetch(
              `${base}/plugins/pendia-plugin-greeter/boom`,
            );
            expect(boom.status).toBe(500);
            expect((await admin.me()).admin).toBe(true);
            const [failed] = (await admin.plugins.list()).plugins;
            expect(failed).toMatchObject({
              enabled: false,
              failure: { message: "greeter broke" },
            });
            const gone = await fetch(
              `${base}/plugins/pendia-plugin-greeter/hello`,
            );
            expect(gone.status).toBe(404);
            const [restarted] = (
              await admin.plugins.setEnabled({
                name: "pendia-plugin-greeter",
                enabled: true,
              })
            ).plugins;
            expect(restarted).toMatchObject({ enabled: true, failure: null });
          });
          await withServer(url, join(folder, "fresh"), async (base) => {
            const hello = await fetch(
              `${base}/plugins/pendia-plugin-greeter/hello`,
            );
            expect(hello.status).toBe(200);
          });
        } finally {
          await packages.stop(true);
        }
      }),
    ));

  test("registries are added, listed with their entries and removed", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const tokens = await seed(db);
      const registry = Bun.serve({
        port: 0,
        fetch: () =>
          Response.json({
            plugins: [
              {
                name: "pendia-plugin-greeter",
                versions: [
                  { version: "1.0.0", source: "pendia-plugin-greeter@1.0.0" },
                ],
              },
            ],
          }),
      });
      const local = `http://127.0.0.1:${registry.port}/`;
      try {
        await withFolder((folder) =>
          withServer(url, folder, async (_, client) => {
            const admin = client(tokens.admin);
            expect(
              await admin.registries.remove({ url: officialRegistry }),
            ).toEqual([]);
            expect(await admin.registries.add({ url: local })).toEqual([local]);
            expect(await admin.registries.list()).toEqual([
              {
                url: local,
                entries: [
                  {
                    name: "pendia-plugin-greeter",
                    description: null,
                    versions: [
                      {
                        version: "1.0.0",
                        source: "pendia-plugin-greeter@1.0.0",
                      },
                    ],
                  },
                ],
                error: null,
              },
            ]);
            expect(
              (await capture(admin.registries.add({ url: "ftp://nope" }))).code,
            ).toBe("BAD_REQUEST");
            expect(await admin.registries.remove({ url: local })).toEqual([]);
          }),
        );
      } finally {
        await registry.stop(true);
      }
    }));
});
