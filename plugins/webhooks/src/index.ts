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

export default definePlugin((host) => {
  const { events: bus, fetch, items, log } = host;
  if (bus === undefined || fetch === undefined)
    throw new Error("Webhooks needs the events and network capabilities.");

  /** Sends once; resolves whether the attempt is final, logging what went wrong. */
  const send = async (
    config: Config & { url: string },
    headers: [string, string][],
    body: string,
  ): Promise<boolean> => {
    try {
      const response = await fetch(config.url, {
        method: config.method,
        headers,
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await response.body?.cancel();
      if (response.status < 400) return true;
      log.warn("webhook.rejected", {
        url: config.url,
        status: response.status,
      });
      return response.status < 500;
    } catch (error) {
      log.warn("webhook.unreachable", {
        url: config.url,
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
    if (invalid.length > 0) log.warn("webhook.headers.skipped", { invalid });
    if (!headers.some(([name]) => name.toLowerCase() === "content-type"))
      headers.push(["Content-Type", "application/json"]);
    // A receiver that stays down is logged, never thrown: a throw would
    // disable the plugin for every other event.
    for (let attempt = 0; ; attempt++) {
      if (await send({ ...config, url }, headers, body)) return;
      if (attempt >= config.retries) {
        log.error("webhook.failed", { url, event, attempts: attempt + 1 });
        return;
      }
      await Bun.sleep(firstRetryDelayMs * 2 ** attempt);
    }
  }

  for (const event of events) bus.on(event, (data) => deliver(event, data));
});
