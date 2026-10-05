import { describe, expect, test } from "bun:test";
import {
  adminSections,
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
