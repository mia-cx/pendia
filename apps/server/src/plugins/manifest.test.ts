import { describe, expect, test } from "bun:test";
import { readPluginPackage } from "./manifest.ts";

const valid = {
  name: "thalia-plugin-prunarr",
  version: "1.2.3",
  thalia: {
    api: "^1.0.0",
    capabilities: ["items:read", "network", "network"],
    network: ["radarr.example"],
    config: {
      type: "object",
      properties: { radarrUrl: { type: "string" } },
    },
    entry: "./dist/index.js",
  },
};

function withThalia(thalia: Record<string, unknown>) {
  return { ...valid, thalia: { ...valid.thalia, ...thalia } };
}

describe("readPluginPackage", () => {
  test("reads a valid package with deduplicated capabilities and a normalized entry", () => {
    expect(readPluginPackage(valid)).toEqual({
      name: "thalia-plugin-prunarr",
      version: "1.2.3",
      manifest: {
        api: "^1.0.0",
        capabilities: ["items:read", "network"],
        network: ["radarr.example"],
        config: {
          type: "object",
          properties: { radarrUrl: { type: "string" } },
        },
        entry: "dist/index.js",
      },
    });
  });

  test("accepts a scoped name and no config", () => {
    const { config: _, ...thalia } = valid.thalia;
    const read = readPluginPackage({ ...valid, name: "@thalia/x", thalia });
    expect(read.name).toBe("@thalia/x");
    expect(read.manifest.config).toBeNull();
  });

  test("accepts * for any host", () => {
    expect(
      readPluginPackage(withThalia({ network: ["*"] })).manifest.network,
    ).toEqual(["*"]);
  });

  test.each([
    ["a non-object", "nope", "package.json must be an object"],
    ["an uppercase name", { ...valid, name: "Bad" }, "name"],
    ["a loose version", { ...valid, version: "1.2" }, "version"],
    ["no thalia block", { name: "x", version: "1.0.0" }, "thalia block"],
    ["an api range the host misses", withThalia({ api: "^2.0.0" }), "host API"],
    [
      "an unknown capability",
      withThalia({ capabilities: ["root"] }),
      "unknown capability root",
    ],
    [
      "items:write without items:read",
      withThalia({ capabilities: ["items:write"] }),
      "items:write needs items:read",
    ],
    [
      "a URL in the network list",
      withThalia({ network: ["https://radarr.example"] }),
      "thalia.network",
    ],
    [
      "a partial wildcard in the network list",
      withThalia({ network: ["*.example"] }),
      "thalia.network",
    ],
    [
      "an entry outside the package",
      withThalia({ entry: "../escape.js" }),
      "inside the package",
    ],
    [
      "an absolute entry",
      withThalia({ entry: "/etc/x.js" }),
      "inside the package",
    ],
    [
      "a config that is not an object schema",
      withThalia({ config: { type: "string" } }),
      "object schema",
    ],
    [
      "a config with an unsupported type",
      withThalia({
        config: { type: "object", properties: { a: { type: "date" } } },
      }),
      "config.properties.a has an unsupported type",
    ],
  ])("rejects %s", (_, json, message) => {
    expect(() => readPluginPackage(json)).toThrow(message);
  });
});
