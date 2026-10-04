import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { queuesScan, refusedRoot, removedRoots } from "./roots.ts";

const saved = [
  { id: "a", path: "/srv/movies" },
  { id: "b", path: "/srv/more" },
];

describe("removedRoots", () => {
  test("names the saved roots missing from the draft", () => {
    expect(removedRoots(saved, saved)).toEqual([]);
    expect(removedRoots(saved, [saved[1]])).toEqual([saved[0]]);
    expect(removedRoots(saved, [])).toEqual(saved);
    expect(
      removedRoots(saved, [{ path: "/new" }, { id: "b", path: "/other" }]),
    ).toEqual([saved[0]]);
  });
});

describe("queuesScan", () => {
  test("a new row or a repointed root queues a scan", () => {
    expect(queuesScan(saved, [...saved, { path: "/new" }])).toBe(true);
    expect(queuesScan(saved, [{ id: "a", path: "/elsewhere" }, saved[1]])).toBe(
      true,
    );
  });

  test("a reorder, rename or pure removal does not", () => {
    expect(queuesScan(saved, [saved[1], saved[0]])).toBe(false);
    expect(queuesScan(saved, [saved[0]])).toBe(false);
    expect(queuesScan([], [])).toBe(false);
  });
});

describe("refusedRoot", () => {
  test("reads the row index off an ORPCError's data", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "This folder overlaps another folder of this library.",
      data: { root: 1 },
    });
    expect(refusedRoot(error)).toEqual({
      index: 1,
      message: "This folder overlaps another folder of this library.",
    });
  });

  test("a list-level error carries no row", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "A library needs at least one folder.",
    });
    expect(refusedRoot(error)).toBeUndefined();
    expect(
      refusedRoot(
        new ORPCError("BAD_REQUEST", { data: { root: "0" }, message: "x" }),
      ),
    ).toBeUndefined();
  });

  test("other errors have nothing to say", () => {
    expect(refusedRoot(new Error("nope"))).toBeUndefined();
    expect(refusedRoot("nope")).toBeUndefined();
  });
});
