import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createThaliaClient } from "../../../web/src/lib/api.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { sessionCookieName } from "../auth/http.ts";
import { login } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { artwork } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { startThalia } from "../index.ts";
import { addRoot, insertLibraries } from "../libraries/testing.ts";
import { withFolder } from "../plugins/testing.ts";

// Google Chrome comes first: Chromium builds without proprietary codecs.
const browser =
  Bun.env.THALIA_BROWSER ??
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null) ??
  undefined;

const webBuild = fileURLToPath(
  new URL("../../../web/build/200.html", import.meta.url),
);

type Pending = {
  resolve: (value: CdpResult) => void;
  reject: (e: Error) => void;
};

type CdpResult = {
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  result?: { value?: unknown };
};

type Paused = { requestId: string; url: string; method: string };

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
  const profileDir = await mkdtemp(join(tmpdir(), "thalia-admin-browser-"));
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
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const closed = page.close.bind(page);
  page.close = async () => {
    await closed();
    await rm(profileDir, { recursive: true, force: true });
  };
  return page;
}

async function signIn(page: Page, base: string, token: string, url: string) {
  await page.send("Network.enable");
  await page.send("Network.setCookie", {
    name: sessionCookieName,
    value: token,
    url: base,
    path: "/",
    httpOnly: true,
  });
  await page.goto(`${base}${url}`);
  await page.waitFor("document.querySelector('h1')");
}

const dialogGone =
  "document.querySelector('[data-slot=dialog-content]') === null && document.querySelector('[data-slot=sheet-content]') === null";
const clickButton = (label: string, scope = "document") =>
  `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click()`;

describe.skipIf(!databaseUrl || browser === undefined)(
  "libraries admin page",
  () => {
    beforeAll(() => {
      if (!existsSync(webBuild))
        throw new Error("Build apps/web before this test.");
    });

    test(
      "a Change opened for one root cannot repoint another root when an earlier removal settles",
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
                deviceId: "libraries-browser",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const dirA = join(folder, "a");
            const dirB = join(folder, "b");
            const dirC = join(folder, "c");
            const repointed = join(folder, "repointed");
            for (const dir of [dirA, dirB, dirC, repointed])
              await mkdir(dir, { recursive: true });
            const [library] = await insertLibraries(db, {
              name: "Movies",
              medium: "movies",
              rootPath: dirA,
            });
            if (library === undefined) throw new Error("Fixture missing.");
            const rootB = await addRoot(db, library.id, dirB);
            const rootC = await addRoot(db, library.id, dirC);
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
              await signIn(page, base, token, `/admin/libraries/${library.id}`);
              await page.waitFor(
                `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change').length === 3`,
              );

              // Hold library writes; every other request goes through.
              const held: Paused[] = [];
              const seen: Paused[] = [];
              await page.send("Fetch.enable", {
                patterns: [
                  {
                    urlPattern: "*/rpc/libraries/*",
                    requestStage: "Request",
                  },
                ],
              });
              page.on(
                "Fetch.requestPaused",
                (p: {
                  requestId: string;
                  request: { url: string; method: string };
                }) => {
                  const paused = {
                    requestId: p.requestId,
                    url: p.request.url,
                    method: p.request.method,
                  };
                  seen.push(paused);
                  if (paused.url.includes("/update")) held.push(paused);
                  else
                    void page.send("Fetch.continueRequest", {
                      requestId: p.requestId,
                    });
                },
              );

              // Removing A dispatches an update that never lands yet.
              await page.eval(
                `document.querySelector(${JSON.stringify(`button[aria-label="Remove ${dirA}"]`)}).click()`,
              );
              await page.waitFor(
                "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Remove folder')",
              );
              await page.eval(clickButton("Remove folder"));
              await Bun.sleep(600);
              if (held.length !== 1)
                throw new Error(`paused: ${JSON.stringify(seen)}`);
              expect(held.length).toBe(1);
              // Dismiss the confirmation while its write is still held.
              await page.eval(
                `[...document.querySelectorAll('[data-slot=alert-dialog-content] button, [role=alertdialog] button')].find(b => b.textContent.trim() === 'Cancel')?.click()`,
              );

              // Open Change for B and navigate to the new folder.
              await page.waitFor(
                `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change').length === 3`,
              );
              await page.eval(
                "[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change')[1].click()",
              );
              await page.waitFor(
                "document.querySelector('button[aria-label=\"Go to a path\"]')",
              );
              await page.eval(
                "document.querySelector('button[aria-label=\"Go to a path\"]').click()",
              );
              await page.waitFor(
                "document.querySelector('input[aria-label=\"Folder path\"]')",
              );
              await page.eval(
                `(() => { const input = document.querySelector('input[aria-label="Folder path"]'); input.value = ${JSON.stringify(repointed)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`,
              );

              // A's removal lands now; B's browser must still write B.
              await page.send("Fetch.continueRequest", {
                requestId: held[0]?.requestId as string,
              });
              await page.waitFor(
                `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Change').length === 2`,
              );

              await page.waitFor(
                `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Use folder' && !b.disabled)`,
              );
              await page.eval(clickButton("Use folder"));
              await Bun.sleep(600);
              if (held.length < 2)
                throw new Error("The repoint update never reached the wire.");
              await page.send("Fetch.continueRequest", {
                requestId: held[1]?.requestId as string,
              });

              const deadline = Date.now() + 10_000;
              let paths = new Map<string, string>();
              while (Date.now() < deadline) {
                const answer = await api.libraries.get({ id: library.id });
                paths = new Map(
                  answer.roots.map((root) => [root.id, root.path]),
                );
                if (paths.get(rootB) === repointed) break;
                await Bun.sleep(200);
              }
              expect(paths.get(rootB)).toBe(repointed);
              expect(paths.get(rootC)).toBe(dirC);
              expect(paths.get(library.rootId)).toBeUndefined();
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "closing the folder browser before its listing answers starts no preview",
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
                deviceId: "libraries-browser-2",
                deviceName: "Chromium",
              },
              "127.0.0.1",
            );
            const root = join(folder, "media");
            const inside = join(folder, "media", "child");
            await mkdir(inside, { recursive: true });
            const [library] = await insertLibraries(db, {
              name: "Movies",
              medium: "movies",
              rootPath: root,
            });
            if (library === undefined) throw new Error("Fixture missing.");
            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
              pluginOptions: { directory: join(folder, "installed") },
            });
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const page = await openPage();
            try {
              await signIn(page, base, token, `/admin/libraries/${library.id}`);
              await page.waitFor(
                `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Change')`,
              );

              // Hold the listing; preview requests only get counted.
              const held: string[] = [];
              const previews: string[] = [];
              const seen: string[] = [];
              await page.send("Fetch.enable", {
                patterns: [
                  {
                    urlPattern: "*/rpc/libraries/*",
                    requestStage: "Request",
                  },
                ],
              });
              page.on(
                "Fetch.requestPaused",
                (p: {
                  requestId: string;
                  request: { url: string; method: string };
                }) => {
                  seen.push(`${p.request.method} ${p.request.url}`);
                  if (p.request.url.includes("/preview")) {
                    previews.push(p.request.url);
                    void page.send("Fetch.continueRequest", {
                      requestId: p.requestId,
                    });
                  } else if (p.request.url.includes("/folders"))
                    held.push(p.requestId);
                  else
                    void page.send("Fetch.continueRequest", {
                      requestId: p.requestId,
                    });
                },
              );

              await page.eval(clickButton("Change"));
              await page.waitFor(
                "document.querySelector('[data-slot=dialog-content], [data-slot=sheet-content]')",
              );
              await Bun.sleep(600);
              expect(held.length).toBe(1);

              // Close before the listing answers, then let it through.
              await page.eval(clickButton("Cancel"));
              await page.waitFor(dialogGone);
              await page.send("Fetch.continueRequest", {
                requestId: held[0] as string,
              });
              await Bun.sleep(1_500);
              if (previews.length !== 0)
                throw new Error(`paused: ${JSON.stringify(seen)}`);
              expect(previews.length).toBe(0);
            } finally {
              await page.close();
              await server.stop();
            }
          }),
        ),
      60_000,
    );

    test(
      "a failed poster image falls back to the printed title without the hover overlay",
      () =>
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
              deviceId: "libraries-browser-3",
              deviceName: "Chromium",
            },
            "127.0.0.1",
          );
          const [library] = await insertLibraries(db, {
            name: "Movies",
            medium: "movies",
            rootPath: "/srv/movies",
          });
          if (library === undefined) throw new Error("Fixture missing.");
          const item = await insertItem(db, {
            libraryId: library.id,
            kind: "movie",
            title: "Poster Fails",
            year: 2001,
            canonicalFolder: "Poster Fails",
            extension: {},
          });
          await db.insert(artwork).values({
            itemId: item.id,
            type: "poster",
            backend: "colocated",
            storageKey: "Poster Fails/poster.jpg",
            selected: true,
          });
          const server = await startThalia("api", {
            databaseUrl: url,
            port: 0,
          });
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const page = await openPage();
          try {
            // Every artwork image fails, so the card must render its fallback.
            await page.send("Fetch.enable", {
              patterns: [
                { urlPattern: "*/api/artwork/*", requestStage: "Request" },
              ],
            });
            page.on("Fetch.requestPaused", (p: { requestId: string }) =>
              page.send("Fetch.failRequest", {
                requestId: p.requestId,
                errorReason: "ConnectionFailed",
              }),
            );
            await signIn(page, base, token, "/movies");
            const card = `document.querySelector('a[aria-label^="Poster Fails"]')`;
            await page.waitFor(
              `${card}?.querySelector('.artwork-fallback .text-title-3')?.textContent.includes('Poster Fails')`,
            );

            // Keyboard-focus the card; the overlay must not exist at all.
            for (let i = 0; i < 50; i++) {
              await page.send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "Tab",
                code: "Tab",
                windowsVirtualKeyCode: 9,
              });
              await page.send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "Tab",
                code: "Tab",
                windowsVirtualKeyCode: 9,
              });
              if (await page.eval(`document.activeElement === ${card}`)) break;
              await Bun.sleep(60);
            }
            expect(
              await page.eval<boolean>(`document.activeElement === ${card}`),
            ).toBe(true);
            await Bun.sleep(600);
            expect(
              await page.eval<boolean>(
                `[...${card}.querySelectorAll('span')].some(s => s.className.includes('h-[45%]'))`,
              ),
            ).toBe(false);
          } finally {
            await page.close();
            await server.stop();
          }
        }),
      60_000,
    );
  },
);
