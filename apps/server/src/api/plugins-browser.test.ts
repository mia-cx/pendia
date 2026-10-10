import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import {
  type FixturePlugin,
  withFolder,
  writeFixture,
} from "../plugins/testing.ts";
import { browser, openPage, signIn, webBuild } from "./browser-testing.ts";

const older: FixturePlugin = {
  name: "thalia-plugin-older",
  capabilities: [],
  source: "export default () => {};",
};
const fresher: FixturePlugin = {
  name: "thalia-plugin-fresher",
  capabilities: [],
  source: "export default () => {};",
};

const switchState =
  "document.querySelector('[data-slot=switch]')?.getAttribute('aria-checked')";
const dialogName =
  "document.querySelector('[data-slot=dialog-title]')?.textContent.trim()";
const dialogGone =
  "document.querySelector('[data-slot=dialog-content]') === null";

describe.skipIf(!databaseUrl || browser === undefined)(
  "plugins admin page",
  () => {
    beforeAll(() => {
      if (!existsSync(webBuild))
        throw new Error("Build apps/web before this test.");
    });

    test(
      "a rejected enable leaves the Switch on the saved state and the next click retries",
      () =>
        withFolder((folder) =>
          withDatabase(async (db, url) => {
            if (browser === undefined) throw new Error("Expected a browser.");
            await migrateDatabase(db);
            await setupAdmin(db, {
              username: "admin",
              password: "admin-pass",
            });
            const { token } = await login(
              db,
              {
                username: "admin",
                password: "admin-pass",
                clientName: "Thalia Web",
                deviceId: "plugins-browser",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const source = await writeFixture(
              join(folder, "sources", "older"),
              older,
            );
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const api = createThaliaClient({
              origin: base,
              headers: { authorization: `Bearer ${token}` },
            });
            const page = await openPage();
            try {
              const preview = await api.plugins.preview({ source });
              await api.plugins.install({
                source: preview.source,
                integrity: preview.integrity,
              });
              await signIn(page, base, token, "/admin/plugins");
              await page.waitFor(
                "document.querySelector('[data-slot=switch]')",
              );
              expect(await page.eval<string>(switchState)).toBe("true");

              // Fail every save; the switch must fall back to "On".
              let failSaves = true;
              await page.send("Fetch.enable", {
                patterns: [
                  {
                    urlPattern: "*/rpc/plugins/setEnabled*",
                    requestStage: "Request",
                  },
                ],
              });
              page.on("Fetch.requestPaused", (p: { requestId: string }) =>
                page.send(
                  failSaves ? "Fetch.failRequest" : "Fetch.continueRequest",
                  { requestId: p.requestId, errorReason: "ConnectionFailed" },
                ),
              );
              await page.eval(
                "document.querySelector('[data-slot=switch]').click()",
              );
              await page.waitFor("document.querySelector('[role=alert]')");
              // The card's text still says On, and the switch went back.
              expect(await page.eval<string>(switchState)).toBe("true");
              expect(
                await page.eval<boolean>(
                  "document.querySelector('article').innerText.includes('On')",
                ),
              ).toBe(true);

              // Let the save through; the next click sends the intent again.
              failSaves = false;
              await page.eval(
                "document.querySelector('[data-slot=switch]').click()",
              );
              const deadline = Date.now() + 10_000;
              let enabled = true;
              while (Date.now() < deadline && enabled) {
                enabled =
                  (await api.plugins.list()).plugins[0]?.enabled ?? true;
                if (enabled) await Bun.sleep(200);
              }
              expect(enabled).toBe(false);
              // The save's answer can reach the API before the page renders it.
              await page.waitFor(`${switchState} === "false"`);
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "a stale registry preview cannot replace the Add-plugin preview or reopen the dialog",
      () =>
        withFolder((folder) =>
          withDatabase(async (db, url) => {
            if (browser === undefined) throw new Error("Expected a browser.");
            await migrateDatabase(db);
            await setupAdmin(db, {
              username: "admin",
              password: "admin-pass",
            });
            const { token } = await login(
              db,
              {
                username: "admin",
                password: "admin-pass",
                clientName: "Thalia Web",
                deviceId: "plugins-browser-2",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const staleSource = await writeFixture(
              join(folder, "sources", "older"),
              older,
            );
            const freshSource = await writeFixture(
              join(folder, "sources", "fresher"),
              fresher,
            );
            // A registry manifest naming the stale plugin's folder.
            const registry = Bun.serve({
              port: 0,
              fetch(request) {
                if (request.url.endsWith("/thalia-registry.json"))
                  return Response.json({
                    plugins: [
                      {
                        name: older.name,
                        description: "the stale entry",
                        versions: [{ version: "1.0.0", source: staleSource }],
                      },
                    ],
                  });
                return new Response(null, { status: 404 });
              },
            });
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const api = createThaliaClient({
              origin: base,
              headers: { authorization: `Bearer ${token}` },
            });
            const page = await openPage();
            try {
              await api.registries.add({
                url: `http://127.0.0.1:${registry.port}/registry`,
              });
              await signIn(page, base, token, "/admin/plugins");
              await page.waitFor(
                `[...document.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') ?? '').includes(${JSON.stringify(older.name)}))`,
              );

              // Every preview request pauses here; the test continues them.
              const held: string[] = [];
              page.on("Fetch.requestPaused", (p: { requestId: string }) =>
                held.push(p.requestId),
              );
              await page.send("Fetch.enable", {
                patterns: [
                  {
                    urlPattern: "*/rpc/plugins/preview*",
                    requestStage: "Request",
                  },
                ],
              });

              // The registry preview starts and waits.
              await page.eval(
                `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').includes(${JSON.stringify(older.name)})).click()`,
              );
              await Bun.sleep(600); // let the request reach the wire
              expect(held.length).toBe(1);

              // The newer Add-plugin preview answers first and wins.
              await page.eval(
                "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add plugin').click()",
              );
              await page.waitFor("document.querySelector('#source')");
              await page.eval(
                `(() => { const input = document.querySelector('#source'); input.value = ${JSON.stringify(freshSource)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#source').closest('form').querySelector('button[type=submit]').click(); })()`,
              );
              await Bun.sleep(600);
              expect(held.length).toBe(2);
              await page.send("Fetch.continueRequest", {
                requestId: held[1] as string,
              });
              await page.waitFor(
                `(${dialogName}) === ${JSON.stringify(fresher.name)}`,
                15_000,
              );

              // The stale preview lands now and must not move the dialog.
              await page.send("Fetch.continueRequest", {
                requestId: held[0] as string,
              });
              await Bun.sleep(800);
              expect(await page.eval<string>(dialogName)).toBe(fresher.name);
              expect(
                await page.eval<boolean>(
                  `document.querySelector('#source') === null`,
                ),
              ).toBe(true);

              // Closing the dialog retires a pending preview too: start the
              // registry flow again, open and close Add before it answers.
              await page.eval(
                "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel').click()",
              );
              await page.waitFor(dialogGone);
              await page.eval(
                `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '').includes(${JSON.stringify(older.name)})).click()`,
              );
              await Bun.sleep(600);
              expect(held.length).toBe(3);
              await page.eval(
                "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add plugin').click()",
              );
              await page.waitFor("document.querySelector('#source')");
              await page.eval(
                "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel').click()",
              );
              await page.waitFor(dialogGone);
              await page.send("Fetch.continueRequest", {
                requestId: held[2] as string,
              });
              await Bun.sleep(800);
              // The retired preview must not reopen the dialog.
              expect(await page.eval<boolean>(dialogGone)).toBe(true);
            } finally {
              await page.close();
              await server.stop();
              registry.stop();
            }
          }),
        ),
      60_000,
    );
  },
);
