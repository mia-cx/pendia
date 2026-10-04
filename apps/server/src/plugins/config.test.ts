import { describe, expect, test } from "bun:test";
import { configErrors, readConfigSchema, withDefaults } from "./config.ts";

const schema = readConfigSchema({
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", title: "Radarr URL" },
    days: { type: "integer", default: 30 },
    mode: { enum: ["dry", "live"], default: "dry" },
    tags: { type: "array", items: { type: "string" } },
  },
});

describe("plugin config", () => {
  test("reads the supported subset", () => {
    expect(schema.properties?.url).toEqual({
      type: "string",
      title: "Radarr URL",
    });
    expect(schema.required).toEqual(["url"]);
  });

  test.each([
    [{ type: "date" }, "config has an unsupported type."],
    [{ properties: [] }, "config properties must be an object."],
    [{ required: [1] }, "config required must list property names."],
    [{ items: { title: 1 } }, "config.items title must be a string."],
    [{ default: Number.NaN }, "config default must be a JSON value."],
  ])("rejects %j", (value, message) => {
    expect(() => readConfigSchema(value)).toThrow(message);
  });

  test("accepts a valid config", () => {
    expect(
      configErrors(schema, { url: "http://radarr", days: 7, tags: ["a"] }),
    ).toEqual([]);
  });

  test("lists every error with its path", () => {
    expect(
      configErrors(schema, { days: 1.5, mode: "loud", tags: ["a", 2] }),
    ).toEqual([
      "config.url is required.",
      "config.days must be integer.",
      "config.mode must be one of the listed values.",
      "config.tags[1] must be string.",
    ]);
    expect(configErrors(schema, [])).toEqual(["config must be object."]);
  });

  test("fills top-level defaults under stored values", () => {
    expect(withDefaults(schema, { url: "x", days: 3 })).toEqual({
      days: 3,
      mode: "dry",
      url: "x",
    });
    expect(withDefaults(null, { a: 1 })).toEqual({ a: 1 });
  });
});
