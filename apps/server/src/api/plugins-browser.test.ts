import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPendiaClient } from "../../../web/src/lib/api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { sessionCookieName } from "../auth/http.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import {
  type FixturePlugin,
  withFolder,
  writeFixture,
} from "../plugins/testing.ts";

// Google Chrome comes first: Chromium builds without proprietary codecs.
const browser =
  Bun.env.PENDIA_BROWSER ??
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null) ??
  undefined;

const webBuild = fileURLToPath(
  new URL("../../../web/build/200.html", import.meta.url),
);

const older: FixturePlugin = {
  name: "pendia-plugin-older",
  capabilities: [],
  source: "export default () => {};",
};
const fresher: FixturePlugin = {
  name: "pendia-plugin-fresher",
  capabilities: [],
  source: "export default () => {};",
};

type Pending = {
  resolve: (value: CdpResult) => void;
  reject: (e: Error) => void;
};

type CdpResult = {
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  result?: { value?: unknown };
};

/** A page target of a Chromium started with --remote-debugging-port=0. */
class Page {
  #id = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, ((params: never) => void)[]>();
  constructor(
    readonly ws: WebSocket,
    readonly proc: Bun.Subprocess,
  ) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error)
          pending?.reject(new Error(JSON.stringify(message.error)));
        else pending?.resolve(message.result as CdpResult);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? [])
        listener(message.params as never);
    });
  }
  send(method: string, params: Record<string, unknown> = {}) {
    return new Promise<CdpResult>((resolve, reject) => {
      const id = ++this.#id;
      this.ws.send(JSON.stringify({ id, method, params }));
      this.#pending.set(id, { resolve, reject });
    });
  }
  on<T = Record<string, unknown>>(
    method: string,
    listener: (params: T) => void,
  ) {
    this.#listeners.set(method, [
      ...(this.#listeners.get(method) ?? []),
      listener as (params: never) => void,
    ]);
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value as T;
  }
  async goto(url: string) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'");
  }
  async waitFor(expression: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.eval<boolean>(`Boolean(${expression})`)) return;
      } catch {}
      await Bun.sleep(150);
    }
    const body = await this.eval<string>(
      "document.body.innerText.slice(0, 800) + ' ||| slots: ' + [...document.querySelectorAll('[data-slot]')].map(e => e.getAttribute('data-slot')).join(',') + ' ||| url: ' + location.href",
    ).catch(() => "");
    throw new Error(`Timed out waiting for ${expression}; page says: ${body}`);
  }
  async close() {
    this.ws.close();
    this.proc.kill();
    await this.proc.exited;
  }
}

async function openPage(): Promise<Page> {
  const profileDir = await mkdtemp(join(tmpdir(), "pendia-admin-browser-"));
  const proc = Bun.spawn(
    [
      browser as string,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  let port: number | undefined;
  for (let i = 0; i < 100; i++) {
    const text = await Bun.file(join(profileDir, "DevToolsActivePort"))
      .text()
      .catch(() => null);
    const first = text?.split("\n")[0];
    if (first) {
      port = Number(first);
      break;
    }
    await Bun.sleep(100);
  }
  if (port === undefined) {
    proc.kill();
    throw new Error("Chromium opened no debug port.");
  }
  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 100; i++) {
    targets = await fetch(`http://127.0.0.1:${port}/json`)
      .then((response) => response.json())
      .catch(() => []);
    if (targets.some((target) => target.type === "page")) break;
    await Bun.sleep(100);
  }
  const target = targets.find((entry) => entry.type === "page");
  if (target === undefined) {
    proc.kill();
    throw new Error("Chromium opened no page target.");
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP failed")), {
      once: true,
    });
  });
  const page = new Page(ws, proc);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const closed = page.close.bind(page);
  page.close = async () => {
    await closed();
    await rm(profileDir, { recursive: true, force: true });
  };
  return page;
}

async function signIn(page: Page, base: string, token: string) {
  await page.send("Network.enable");
  await page.send("Network.setCookie", {
    name: sessionCookieName,
    value: token,
    url: base,
    path: "/",
    httpOnly: true,
  });
  await page.goto(`${base}/admin/plugins`);
  await page.waitFor("document.querySelector('h1')");
}

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
                clientName: "Pendia Web",
                deviceId: "plugins-browser",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const source = await writeFixture(
              join(folder, "sources", "older"),
              older,
            );
            const server = await startPendia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const api = createPendiaClient({
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
              await signIn(page, base, token);
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
              await page.waitFor(
                "document.querySelector('[role=alert]')",
                10_000,
              );
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
              expect(await page.eval<string>(switchState)).toBe("false");
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
                clientName: "Pendia Web",
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
                if (request.url.endsWith("/pendia-registry.json"))
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
            const server = await startPendia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const api = createPendiaClient({
              origin: base,
              headers: { authorization: `Bearer ${token}` },
            });
            const page = await openPage();
            try {
              await api.registries.add({
                url: `http://127.0.0.1:${registry.port}/registry`,
              });
              await signIn(page, base, token);
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
