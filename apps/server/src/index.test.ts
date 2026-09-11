import { describe, expect, test } from "bun:test";
import { parseRole, type Role, requireSupportedBunVersion } from "./index.ts";

describe("parseRole", () => {
  const roles: Role[] = ["api", "worker", "transcoder", "watcher", "all"];

  for (const role of roles) {
    test(`accepts ${role}`, () => {
      expect(parseRole(["--role", role])).toBe(role);
    });
  }

  test("rejects an unknown role", () => {
    expect(() => parseRole(["--role", "unknown"])).toThrow(
      'Unknown role "unknown".',
    );
  });
});

describe("requireSupportedBunVersion", () => {
  test("rejects Bun 1.3.11", () => {
    expect(() => requireSupportedBunVersion("1.3.11")).toThrow(
      "Pendia requires Bun 1.4.0 or later.",
    );
  });

  test("accepts Bun 1.4.0", () => {
    expect(() => requireSupportedBunVersion("1.4.0")).not.toThrow();
  });
});
