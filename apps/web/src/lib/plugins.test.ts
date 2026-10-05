import { describe, expect, test } from "bun:test";
import {
  describeCapabilities,
  entryAction,
  filesChoice,
  filesOffFor,
  type InstalledPlugin,
  officialRegistry,
  pluginOrigin,
  type Registry,
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
        name: "@pendia/plugin-webhooks",
        description: "Send server events to any HTTP endpoint.",
        versions: [
          { version: "1.0.0", source: "@pendia/plugin-webhooks@1.0.0" },
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
    expect(registryLabel(officialRegistry)).toBe("Pendia registry");
    expect(registryLabel("https://plugins.example.com/list.json")).toBe(
      "plugins.example.com",
    );
    expect(registryLabel("not a url")).toBe("not a url");
  });

  test("names a plugin's origin from registry entries, then the source shape", () => {
    expect(pluginOrigin("@pendia/plugin-webhooks@1.0.0", registries)).toBe(
      "Pendia registry",
    );
    expect(pluginOrigin("/srv/plugins/tool", registries)).toBe("Local folder");
    expect(pluginOrigin("https://x.example/p.tgz", registries)).toBe(
      "x.example",
    );
    expect(pluginOrigin("pendia-plugin-tool@2.0.0", registries)).toBe("npm");
  });

  test("an entry reads install, update or installed against the list", () => {
    const installed = [
      { name: "@pendia/plugin-webhooks", version: "1.0.0" },
      { name: "pendia-plugin-tool", version: "0.9.0" },
    ] as InstalledPlugin[];
    const webhook = registries[0]?.entries[0];
    if (webhook === undefined) throw new Error("fixture has no webhook entry");
    const tool = {
      name: "pendia-plugin-tool",
      description: null,
      versions: [{ version: "1.0.0", source: "pendia-plugin-tool@1.0.0" }],
    };
    expect(entryAction(webhook, installed)).toBe("installed");
    expect(entryAction(tool, installed)).toBe("update");
    expect(
      entryAction(
        {
          name: "pendia-plugin-new",
          description: null,
          versions: [{ version: "1.0.0", source: "pendia-plugin-new@1.0.0" }],
        },
        installed,
      ),
    ).toBe("install");
  });
});
