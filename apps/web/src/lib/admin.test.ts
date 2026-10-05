import { describe, expect, test } from "bun:test";
import {
  adminSections,
  checkHealth,
  currentSection,
  matchSections,
  navDirection,
} from "./admin.ts";

describe("matchSections", () => {
  test("matches a label substring", () => {
    expect(matchSections("lib").map((s) => s.id)).toEqual(["libraries"]);
  });

  test("matches a keyword", () => {
    expect(matchSections("invite").map((s) => s.id)).toEqual(["users"]);
  });

  test("ignores case and surrounding whitespace", () => {
    expect(matchSections("  OIDC ").map((s) => s.id)).toEqual(["general"]);
  });

  test("empty query returns every section in order", () => {
    expect(matchSections("")).toEqual(adminSections);
    expect(matchSections("   ")).toEqual(adminSections);
  });

  test("no match returns empty", () => {
    expect(matchSections("zzz")).toEqual([]);
  });
});

describe("currentSection", () => {
  const at = (path: string) => currentSection(new URL(`http://x${path}`));

  test("/admin is overview", () => {
    expect(at("/admin")).toBe("overview");
  });

  test("/admin/overview is overview", () => {
    expect(at("/admin/overview")).toBe("overview");
  });

  test("nested paths count", () => {
    expect(at("/admin/users/abc")).toBe("users");
    expect(at("/admin/libraries/abc/scan")).toBe("libraries");
  });

  test("non-admin paths are undefined", () => {
    expect(at("/movies")).toBeUndefined();
  });
});

describe("navDirection", () => {
  test("deeper pushes", () => {
    expect(navDirection("/admin", "/admin/users")).toBe("push");
    expect(navDirection("/admin/users", "/admin/users/abc")).toBe("push");
  });

  test("shallower pops", () => {
    expect(navDirection("/admin/users/abc", "/admin/users")).toBe("pop");
    expect(navDirection("/admin/users", "/admin")).toBe("pop");
  });

  test("same depth or non-admin paths are null", () => {
    expect(navDirection("/admin/users", "/admin/groups")).toBeNull();
    expect(navDirection("/admin", "/movies")).toBeNull();
    expect(navDirection("/movies", "/admin/users")).toBeNull();
  });
});

describe("checkHealth", () => {
  const json = (status: number) =>
    new Response("{}", {
      status,
      headers: { "content-type": "application/json" },
    });
  const transportOf = (response: Response) =>
    (async () => response) as unknown as typeof fetch;

  test("a JSON 200 is ready", async () => {
    expect(await checkHealth(transportOf(json(200)))).toBe("ready");
  });

  test("a JSON 503 is no-database", async () => {
    expect(await checkHealth(transportOf(json(503)))).toBe("no-database");
  });

  test("an HTML 502 is unreachable", async () => {
    const html = new Response("<html>bad gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    expect(await checkHealth(transportOf(html))).toBe("unreachable");
  });

  test("a transport that throws a TypeError is unreachable", async () => {
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkHealth(broken)).toBe("unreachable");
  });

  test("a JSON 404 is unreachable", async () => {
    expect(await checkHealth(transportOf(json(404)))).toBe("unreachable");
  });
});
