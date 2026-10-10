import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookieName } from "../auth/http.ts";

/** The browser the admin browser tests drive; Google Chrome first, since Chromium builds lack proprietary codecs. */
export const browser =
  Bun.env.THALIA_BROWSER ??
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null) ??
  undefined;

/** The built web app the API serves; the browser tests need it. */
export const webBuild = fileURLToPath(
  new URL("../../../web/build/200.html", import.meta.url),
);

// A cold Chromium on a loaded CI runner can take well over ten seconds to
// write its debug port.
const startupMs = 45_000;
const pollMs = 100;

type CdpResult = {
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  result?: { value?: unknown };
};

type Pending = {
  resolve: (value: CdpResult) => void;
  reject: (e: Error) => void;
};

/** A page target of a Chromium started with --remote-debugging-port=0. */
export class Page {
  #id = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, ((params: never) => void)[]>();
  constructor(
    readonly ws: WebSocket,
    readonly proc: Bun.Subprocess,
    readonly profileDir: string,
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
    await rm(this.profileDir, { recursive: true, force: true });
  }
}

async function readPort(profileDir: string, proc: Bun.Subprocess) {
  const deadline = Date.now() + startupMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null)
      throw new Error(
        `Chromium exited before opening its debug port (${proc.signalCode ?? proc.exitCode}).`,
      );
    const text = await Bun.file(join(profileDir, "DevToolsActivePort"))
      .text()
      .catch(() => null);
    const first = text?.split("\n")[0];
    if (first) return Number(first);
    await Bun.sleep(pollMs);
  }
  throw new Error(`Chromium opened no debug port within ${startupMs} ms.`);
}

async function readPageTarget(port: number) {
  const deadline = Date.now() + startupMs;
  while (Date.now() < deadline) {
    const targets: { type: string; webSocketDebuggerUrl: string }[] =
      await fetch(`http://127.0.0.1:${port}/json`)
        .then((response) => response.json())
        .catch(() => []);
    const target = targets.find((entry) => entry.type === "page");
    if (target !== undefined) return target;
    await Bun.sleep(pollMs);
  }
  throw new Error("Chromium opened no page target.");
}

/** Starts a headless browser at 1440x900 and attaches to its first page. */
export async function openPage(): Promise<Page> {
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
  try {
    const target = await readPageTarget(await readPort(profileDir, proc));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP failed")), {
        once: true,
      });
    });
    const page = new Page(ws, proc, profileDir);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return page;
  } catch (error) {
    proc.kill();
    await proc.exited;
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

/** Signs the page in with a session cookie, opens `path` and waits for its heading. */
export async function signIn(
  page: Page,
  base: string,
  token: string,
  path: string,
) {
  await page.send("Network.enable");
  await page.send("Network.setCookie", {
    name: sessionCookieName,
    value: token,
    url: base,
    path: "/",
    httpOnly: true,
  });
  await page.goto(`${base}${path}`);
  await page.waitFor("document.querySelector('h1')");
}
