import { describe, expect, test } from "bun:test";
import {
  decodeCursor,
  encodeCursor,
  type PageKey,
  toPage,
} from "./pagination.ts";

const key: PageKey = {
  addedAt: "2026-02-03T04:05:06.789000Z",
  id: "0190a8f2-7c3d-7e2f-8a4b-1c2d3e4f5a6b",
};

const encode = (raw: string) => Buffer.from(raw).toString("base64url");

describe("pagination", () => {
  test("a cursor round-trips through encode and decode", () => {
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  test("malformed cursors decode to undefined", () => {
    const cases = [
      "",
      "not-a-cursor",
      "%%%",
      encode("only-one-part"),
      encode("a|b|c"),
      encode(`not-a-date|${key.id}`),
      encode(`${key.addedAt}|not-a-uuid`),
      encode(`2026-02-03|${key.id}`),
      encode(`2026-02-30T04:05:06.789000Z|${key.id}`),
      encode(`2026-02-03T04:05:06.7890000Z|${key.id}`),
    ];
    for (const cursor of cases) expect(decodeCursor(cursor)).toBeUndefined();
  });

  test("toPage returns a null cursor when the rows fit", () => {
    const rows = ["a", "b", "c"];
    const page = toPage(rows, 24, () => key);
    expect(page.items).toEqual(rows);
    expect(page.cursor).toBeNull();
  });

  test("toPage returns the last kept row's cursor when rows overflow", () => {
    const rows = [0, 1, 2, 3].map((index) => ({
      addedAt: `2026-01-04T00:00:0${index}.000000Z`,
      id: `00000000-0000-7000-8000-00000000000${index}`,
    }));
    const page = toPage(rows, 3, (row) => row);
    const lastKept = rows[2];
    if (!lastKept) throw new Error("Test row missing.");
    expect(page.items).toEqual(rows.slice(0, 3));
    expect(page.cursor).toBe(encodeCursor(lastKept));
    expect(decodeCursor(page.cursor ?? "")).toEqual(lastKept);
  });
});
