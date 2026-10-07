import { describe, expect, test } from "bun:test";
import {
  type ConfigField,
  describeCapabilities,
  entryAction,
  filesChoice,
  filesOffFor,
  type InstalledPlugin,
  notSet,
  officialRegistry,
  pluginOrigin,
  type Registry,
  readPluginConfig,
  registryLabel,
} from "./plugins.ts";

const now = Date.parse("2026-10-04T12:00:00Z");

describe("plugin helpers", () => {
  test("network names its hosts", () => {
    expect(describeCapabilities(["network"], ["radarr.example"])).toEqual([
      "Reach radarr.example",
    ]);
    expect(describeCapabilities(["network"], ["*"])).toEqual([
      "Reach any host",
    ]);
    expect(describeCapabilities(["files"], [])).toEqual([
      "Read, change and delete files in your libraries",
    ]);
  });

  test("a timed switch reads as off until it ends", () => {
    expect(filesChoice(null, now)).toBe("on");
    expect(filesChoice({ until: null }, now)).toBe("off");
    expect(filesChoice({ until: "2026-10-04T13:00:00Z" }, now)).toBe("until");
    expect(filesChoice({ until: "2026-10-04T11:00:00Z" }, now)).toBe("on");
  });

  test("a choice becomes the switch to store", () => {
    expect(filesOffFor("on", now)).toBeNull();
    expect(filesOffFor("off", now)).toEqual({ until: null });
    expect(filesOffFor("hour", now)).toEqual({
      until: "2026-10-04T13:00:00.000Z",
    });
  });
});

const registries: Registry[] = [
  {
    url: officialRegistry,
    entries: [
      {
        name: "@thalia/plugin-webhooks",
        description: "Send server events to any HTTP endpoint.",
        versions: [
          { version: "1.0.0", source: "@thalia/plugin-webhooks@1.0.0" },
        ],
      },
    ],
    error: null,
  },
  {
    url: "http://127.0.0.1:5582/broken.json",
    entries: [],
    error: "answered 404",
  },
];

describe("registry helpers", () => {
  test("labels the official registry, a hostname and a broken URL", () => {
    expect(registryLabel(officialRegistry)).toBe("Thalia registry");
    expect(registryLabel("https://plugins.example.com/list.json")).toBe(
      "plugins.example.com",
    );
    expect(registryLabel("not a url")).toBe("not a url");
  });

  test("names a plugin's origin from registry entries, then the source shape", () => {
    expect(pluginOrigin("@thalia/plugin-webhooks@1.0.0", registries)).toBe(
      "Thalia registry",
    );
    expect(pluginOrigin("/srv/plugins/tool", registries)).toBe("Local folder");
    expect(pluginOrigin("https://x.example/p.tgz", registries)).toBe(
      "x.example",
    );
    expect(pluginOrigin("thalia-plugin-tool@2.0.0", registries)).toBe("npm");
  });

  test("an entry reads install, update or installed against the list", () => {
    const installed = [
      { name: "@thalia/plugin-webhooks", version: "1.0.0" },
      { name: "thalia-plugin-tool", version: "0.9.0" },
    ] as InstalledPlugin[];
    const webhook = registries[0]?.entries[0];
    if (webhook === undefined) throw new Error("fixture has no webhook entry");
    const tool = {
      name: "thalia-plugin-tool",
      description: null,
      versions: [{ version: "1.0.0", source: "thalia-plugin-tool@1.0.0" }],
    };
    expect(entryAction(webhook, installed)).toBe("installed");
    expect(entryAction(tool, installed)).toBe("update");
    expect(
      entryAction(
        {
          name: "thalia-plugin-new",
          description: null,
          versions: [{ version: "1.0.0", source: "thalia-plugin-new@1.0.0" }],
        },
        installed,
      ),
    ).toBe("install");
  });
});

const field = (
  partial: Partial<ConfigField> & { key: string },
): ConfigField => ({
  type: null,
  title: null,
  description: null,
  required: false,
  options: null,
  ...partial,
});

describe("readPluginConfig", () => {
  const read = (
    fields: ConfigField[],
    texts: Record<string, unknown>,
    checks: Record<string, boolean> = {},
  ) => readPluginConfig(fields, texts, checks);

  test("number and integer drafts read as numbers", () => {
    const fields = [
      field({ key: "count", type: "number", required: true }),
      field({ key: "tries", type: "integer" }),
    ];
    expect(read(fields, { count: "6", tries: "2" })).toEqual({
      count: 6,
      tries: 2,
    });
  });

  test("an empty optional field is left out", () => {
    expect(read([field({ key: "count", type: "number" })], {})).toEqual({});
  });

  test("a numeric draft from a number input reads as a number", () => {
    expect(
      read([field({ key: "count", type: "number" })], { count: 6 }),
    ).toEqual({ count: 6 });
  });

  test("a cleared optional number draft is left out", () => {
    const fields = [field({ key: "count", type: "number" })];
    expect(read(fields, { count: null })).toEqual({});
    expect(read(fields, { count: undefined })).toEqual({});
  });

  test("a cleared required number names its label", () => {
    const fields = [
      field({ key: "count", type: "number", required: true, title: "Count" }),
    ];
    expect(read(fields, { count: null })).toBe("Count is required.");
  });

  test("booleans come from the switches, not the texts", () => {
    const fields = [
      field({ key: "on", type: "boolean" }),
      field({ key: "off", type: "boolean" }),
    ];
    expect(read(fields, {}, { on: true })).toEqual({ on: true, off: false });
  });

  test("an optional enum left Not set is left out", () => {
    const fields = [field({ key: "mode", options: ["a", "b"] })];
    expect(read(fields, { mode: notSet })).toEqual({});
  });

  test("an empty required enum names its label", () => {
    const fields = [
      field({ key: "mode", title: "Mode", required: true, options: ["a"] }),
    ];
    expect(read(fields, {})).toBe("Mode is required.");
  });

  test("a set enum parses its JSON draft", () => {
    const fields = [
      field({ key: "mode", required: true, options: ["a", "b"] }),
    ];
    expect(read(fields, { mode: '"b"' })).toEqual({ mode: "b" });
  });

  test("a JSON field that is not JSON names its label", () => {
    const fields = [
      field({ key: "headers", title: "Headers", required: true }),
    ];
    expect(read(fields, { headers: "{oops" })).toBe(
      "Headers is not valid JSON.",
    );
  });
});
