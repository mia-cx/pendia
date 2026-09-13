import { describe, expect, test } from "bun:test";
import {
  decideSegment,
  initialState,
  type LiveState,
  runEnded,
  runStarted,
  segmentsReady,
} from "./live-session.ts";

const running: LiveState = {
  ready: new Set([0, 1, 2]),
  run: { startIndex: 0, frontier: 2 },
};

describe("decideSegment", () => {
  test("serves a ready segment", () => {
    expect(decideSegment(running, 1, 10)).toEqual({ action: "serve" });
  });

  test("waits for the segment the run produces next", () => {
    expect(decideSegment(running, 3, 10)).toEqual({ action: "wait" });
  });

  test("restarts for a segment ahead of the frontier", () => {
    expect(decideSegment(running, 5, 10)).toEqual({
      action: "restart",
      index: 5,
    });
  });

  test("restarts for a segment behind the run start", () => {
    const state: LiveState = {
      ready: new Set([5, 6]),
      run: { startIndex: 5, frontier: 6 },
    };
    expect(decideSegment(state, 2, 10)).toEqual({
      action: "restart",
      index: 2,
    });
  });

  test("restarts when no run exists", () => {
    expect(decideSegment(initialState, 0, 10)).toEqual({
      action: "restart",
      index: 0,
    });
  });

  test.each([-1, 10, 1.5])("rejects index %p", (index) => {
    expect(() => decideSegment(running, index, 10)).toThrow(RangeError);
  });
});

describe("runStarted", () => {
  test("opens a run with an empty frontier", () => {
    expect(runStarted(initialState, 4)).toEqual({
      ready: new Set(),
      run: { startIndex: 4, frontier: 3 },
    });
  });
});

describe("segmentsReady", () => {
  test("advances the frontier to the highest index", () => {
    const next = segmentsReady(running, [3, 4]);
    expect(next.ready).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(next.run).toEqual({ startIndex: 0, frontier: 4 });
  });

  test("never lowers the frontier", () => {
    const next = segmentsReady(running, [1]);
    expect(next.run).toEqual({ startIndex: 0, frontier: 2 });
  });

  test("keeps indexes ready when no run exists", () => {
    const next = segmentsReady(initialState, [7]);
    expect(next.ready).toEqual(new Set([7]));
    expect(next.run).toBeNull();
  });
});

describe("runEnded", () => {
  test("a clean exit completes every segment from the run start", () => {
    const next = runEnded(running, true, 10);
    expect(next.run).toBeNull();
    expect(next.ready).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  test("an unclean exit only clears the run", () => {
    const next = runEnded(running, false, 10);
    expect(next.run).toBeNull();
    expect(next.ready).toEqual(new Set([0, 1, 2]));
  });

  test("an unclean exit without a run stays empty", () => {
    expect(runEnded(initialState, false, 10)).toEqual(initialState);
  });
});

test("transitions never mutate their input", () => {
  const state: LiveState = {
    ready: new Set([0, 1, 2]),
    run: { startIndex: 0, frontier: 2 },
  };
  const snapshot = structuredClone(state);
  runStarted(state, 5);
  segmentsReady(state, [3, 4]);
  runEnded(state, true, 10);
  expect(state.ready).toEqual(snapshot.ready);
  expect(state.run).toEqual(snapshot.run);
});
