import { describe, expect, test } from "bun:test";
import { describeCapabilities, filesChoice, filesOffFor } from "./plugins.ts";

const now = Date.parse("2026-10-04T12:00:00Z");

describe("plugin helpers", () => {
  test("network names its hosts", () => {
    expect(describeCapabilities(["network"], ["radarr.example"])).toEqual([
      "Reach radarr.example",
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
