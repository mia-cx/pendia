import { describe, expect, test } from "bun:test";
import { initials, isCurrent, navigation } from "./shell.ts";

const libraries = [
  { id: "fam", name: "Family", medium: "movies" as const },
  { id: "films", name: "Films", medium: "movies" as const },
  { id: "tv", name: "TV", medium: "shows" as const },
];

describe("shell navigation", () => {
  test("orders Search, Home, Movies, Shows and adds Settings for admins only", () => {
    const admin = navigation(true, []);
    expect(admin.map((e) => e.label)).toEqual([
      "Search",
      "Home",
      "Movies",
      "Shows",
      "Settings",
    ]);
    expect(admin[4].href).toBe("/admin");
    const viewer = navigation(false, []);
    expect(viewer.map((e) => e.label)).toEqual([
      "Search",
      "Home",
      "Movies",
      "Shows",
    ]);
  });

  test("lists a medium's libraries as children only with two or more, sorted by name", () => {
    const nav = navigation(false, libraries);
    const movies = nav.find((e) => e.label === "Movies");
    expect(movies?.children).toEqual([
      { href: "/movies?library=fam", label: "Family" },
      { href: "/movies?library=films", label: "Films" },
    ]);
    const shows = nav.find((e) => e.label === "Shows");
    expect(shows?.children).toEqual([]);
  });

  test("matches / only on the exact root", () => {
    expect(isCurrent(new URL("http://x/"), "/")).toBe(true);
    expect(isCurrent(new URL("http://x/movies"), "/")).toBe(false);
    expect(isCurrent(new URL("http://x/?q=a"), "/")).toBe(true);
  });

  test("a section is current on its path and sub-paths, a library child wins over it", () => {
    const section = "/movies";
    const child = "/movies?library=fam";
    expect(isCurrent(new URL("http://x/movies"), section)).toBe(true);
    expect(isCurrent(new URL("http://x/movies/abc"), section)).toBe(true);
    const filtered = new URL("http://x/movies?library=fam");
    expect(isCurrent(filtered, child)).toBe(true);
    expect(isCurrent(filtered, section)).toBe(false);
    expect(isCurrent(new URL("http://x/movies?library=other"), child)).toBe(
      false,
    );
  });

  test("initials take up to two letters, uppercased", () => {
    expect(initials("Mia Chen")).toBe("MC");
    expect(initials("mia")).toBe("M");
  });

  test("search is current with any query", () => {
    expect(isCurrent(new URL("http://x/search?q=the"), "/search")).toBe(true);
    expect(isCurrent(new URL("http://x/search"), "/search")).toBe(true);
    expect(isCurrent(new URL("http://x/search?q=the"), "/")).toBe(false);
  });
});
