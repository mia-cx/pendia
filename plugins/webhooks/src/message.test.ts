import { describe, expect, test } from "bun:test";
import { readHeaders, renderBody } from "./message.ts";

const context = {
  event: "item.added",
  data: { itemId: "a1", kind: "movie" },
  item: { title: 'The "Thing"', year: 1982, genres: ["Horror"] },
};

describe("renderBody", () => {
  test("escapes strings for JSON and writes other values as JSON", () => {
    const body = renderBody(
      '{"text":"Added {{item.title}} ({{ item.year }})","data":{{data}},"genres":{{item.genres}}}',
      context,
    );
    expect(JSON.parse(body)).toEqual({
      text: 'Added The "Thing" (1982)',
      data: { itemId: "a1", kind: "movie" },
      genres: ["Horror"],
    });
  });

  test("a missing path or an inherited key renders nothing", () => {
    expect(
      renderBody("[{{item.missing}}][{{data.constructor}}]", context),
    ).toBe("[][]");
  });

  test("null stays null", () => {
    expect(renderBody('{"item":{{item}}}', { item: null })).toBe(
      '{"item":null}',
    );
  });
});

describe("readHeaders", () => {
  test("splits name and value at the first colon", () => {
    expect(
      readHeaders(["Authorization: Bearer a:b", "X-Empty:", "no colon", ": x"]),
    ).toEqual({
      headers: [
        ["Authorization", "Bearer a:b"],
        ["X-Empty", ""],
      ],
      invalid: ["no colon", ": x"],
    });
  });
});
