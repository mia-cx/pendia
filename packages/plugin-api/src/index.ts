import type { PluginHost } from "../plugin-api.d.ts";

/** Marks a setup callback as a Pendia plugin entry point. */
export const definePlugin = (
  setup: (host: PluginHost) => void | Promise<void>,
) => setup;
