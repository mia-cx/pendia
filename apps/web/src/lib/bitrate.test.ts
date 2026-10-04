import { describe, expect, test } from "bun:test";
import { fromMbps, toMbps } from "./bitrate.ts";

describe("bitrate fields", () => {
  test("Mbit/s round-trips to bits per second; empty clears; nonsense is refused", () => {
    expect(toMbps(2_500_000)).toBe("2.5");
    expect(fromMbps(" 2.5 ")).toBe(2_500_000);
    expect(fromMbps("")).toBeNull();
    for (const text of ["0", "-1", "abc", "1e300"])
      expect(fromMbps(text)).toBeUndefined();
  });
});
