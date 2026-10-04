import { describe, expect, test } from "bun:test";
import { readPluginPackage } from "./manifest.ts";

const valid = {
  name: "pendia-plugin-prunarr",
  version: "1.2.3",
  pendia: {
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

function withPendia(pendia: Record<string, unknown>) {
  return { ...valid, pendia: { ...valid.pendia, ...pendia } };
}

describe("readPluginPackage", () => {
  test("reads a valid package with deduplicated capabilities and a normalized entry", () => {
    expect(readPluginPackage(valid)).toEqual({
      name: "pendia-plugin-prunarr",
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
    const { config: _, ...pendia } = valid.pendia;
    const read = readPluginPackage({ ...valid, name: "@pendia/x", pendia });
    expect(read.name).toBe("@pendia/x");
    expect(read.manifest.config).toBeNull();
  });

  test("accepts * for any host", () => {
    expect(
      readPluginPackage(withPendia({ network: ["*"] })).manifest.network,
    ).toEqual(["*"]);
  });

  test.each([
    ["a non-object", "nope", "package.json must be an object"],
    ["an uppercase name", { ...valid, name: "Bad" }, "name"],
    ["a loose version", { ...valid, version: "1.2" }, "version"],
    ["no pendia block", { name: "x", version: "1.0.0" }, "pendia block"],
    ["an api range the host misses", withPendia({ api: "^2.0.0" }), "host API"],
    [
      "an unknown capability",
      withPendia({ capabilities: ["root"] }),
      "unknown capability root",
    ],
    [
      "items:write without items:read",
      withPendia({ capabilities: ["items:write"] }),
      "items:write needs items:read",
    ],
    [
      "a URL in the network list",
      withPendia({ network: ["https://radarr.example"] }),
      "pendia.network",
    ],
    [
      "a partial wildcard in the network list",
      withPendia({ network: ["*.example"] }),
      "pendia.network",
    ],
    [
      "an entry outside the package",
      withPendia({ entry: "../escape.js" }),
      "inside the package",
    ],
    [
      "an absolute entry",
      withPendia({ entry: "/etc/x.js" }),
      "inside the package",
    ],
    [
      "a config that is not an object schema",
      withPendia({ config: { type: "string" } }),
      "object schema",
    ],
    [
      "a config with an unsupported type",
      withPendia({
        config: { type: "object", properties: { a: { type: "date" } } },
      }),
      "config.properties.a has an unsupported type",
    ],
  ])("rejects %s", (_, json, message) => {
    expect(() => readPluginPackage(json)).toThrow(message);
  });
});
