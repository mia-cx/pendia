import { definePlugin, type PluginEvents } from "@pendia/plugin-api";
import { readHeaders, renderBody } from "./message.ts";

/** The config the plugin's schema in package.json describes, with its defaults filled in. */
type Config = {
  url?: string;
  method: "POST" | "PUT" | "PATCH";
  headers: string[];
  body: string;
  events: (keyof PluginEvents)[];
  retries: number;
};

const events = [
  "item.added",
  "item.removed",
  "item.updated",
  "progress.updated",
  "playback.started",
  "playback.stopped",
  "scan.completed",
] as const satisfies readonly (keyof PluginEvents)[];

const requestTimeoutMs = 10_000;
const firstRetryDelayMs = 1_000;
// Ten retries already wait about 17 minutes in total; more would hold a worker for hours.
const maxRetries = 10;

export default definePlugin((host) => {
  const { events: bus, fetch, items, log } = host;
  if (bus === undefined || fetch === undefined)
    throw new Error("Webhooks needs the events and network capabilities.");

  /** Sends once; resolves whether the attempt is final, logging what went wrong under `endpoint`. */
  const send = async (
    url: string,
    endpoint: string,
    init: {
      method: Config["method"];
      headers: [string, string][];
      body: string;
    },
  ): Promise<boolean> => {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await response.body?.cancel();
      if (response.status < 400) return true;
      log.warn("webhook.rejected", { endpoint, status: response.status });
      return response.status < 500;
    } catch (error) {
      log.warn("webhook.unreachable", {
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  async function deliver<E extends keyof PluginEvents>(
    event: E,
    data: PluginEvents[E],
  ) {
    const config = await host.config.get<Config>();
    const { url } = config;
    if (url === undefined || url === "" || !config.events.includes(event))
      return;
    const item =
      "itemId" in data && items !== undefined
        ? await items.get(data.itemId)
        : null;
    const body = renderBody(config.body, {
      event,
      timestamp: new Date().toISOString(),
      data,
      item,
    });
    const { headers, invalid } = readHeaders(config.headers);
    // Header values and URL paths often hold tokens, so logs name neither.
    if (invalid.length > 0)
      log.warn("webhook.headers.skipped", { count: invalid.length });
    if (!headers.some(([name]) => name.toLowerCase() === "content-type"))
      headers.push(["Content-Type", "application/json"]);
    const endpoint = URL.canParse(url) ? new URL(url).origin : "invalid URL";
    const retries = Math.min(Math.max(config.retries, 0), maxRetries);
    // A receiver that stays down is logged, never thrown: a throw would
    // disable the plugin for every other event.
    for (let attempt = 0; ; attempt++) {
      const init = { method: config.method, headers, body };
      if (await send(url, endpoint, init)) return;
      if (attempt >= retries) {
        log.error("webhook.failed", {
          endpoint,
          event,
          attempts: attempt + 1,
        });
        return;
      }
      await Bun.sleep(firstRetryDelayMs * 2 ** attempt);
    }
  }

  for (const event of events) bus.on(event, (data) => deliver(event, data));
});
