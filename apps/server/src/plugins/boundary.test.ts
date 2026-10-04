import { describe, expect, test } from "bun:test";
import { assertPlainData } from "./boundary.ts";

describe("assertPlainData", () => {
  test("accepts JSON values, byte arrays and absent properties", () => {
    expect(() =>
      assertPlainData({
        text: "a",
        count: 1,
        ok: true,
        none: null,
        missing: undefined,
        list: [1, "two", { three: 3 }],
        bytes: new Uint8Array([1, 2]),
        bare: Object.create(null),
      }),
    ).not.toThrow();
  });

  test("accepts a shared object that is not a cycle", () => {
    const shared = { a: 1 };
    expect(() => assertPlainData([shared, shared])).not.toThrow();
  });

  class Handle {}
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;

  test.each([
    ["a function", { run: () => {} }, "value.run is a function"],
    ["a symbol", [Symbol("x")], "value[0] is a symbol"],
    ["a bigint", { n: 1n }, "value.n is a bigint"],
    ["NaN", { n: Number.NaN }, "value.n is NaN"],
    ["Infinity", [Number.POSITIVE_INFINITY], "value[0] is Infinity"],
    ["a class instance", { handle: new Handle() }, "value.handle is a Handle"],
    ["a Date", { at: new Date() }, "value.at is a Date"],
    ["a Map", new Map(), "value is a Map"],
    ["undefined in an array", [undefined], "value[0] is undefined"],
    ["a cycle", cycle, "value.self is a cycle"],
  ])("rejects %s with its path", (_, value, message) => {
    expect(() => assertPlainData(value)).toThrow(message);
  });
});
