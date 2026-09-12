import { describe, expect, test } from "bun:test";
import {
  deriveSegmentTimeline,
  isTimelineAligned,
  segmentTargetSeconds,
} from "./timeline.ts";

describe("deriveSegmentTimeline", () => {
  test("targets four second boundaries", () => {
    expect(segmentTargetSeconds).toBe(4);
  });

  const derived: [readonly number[], number, number[]][] = [
    [[0, 2, 4, 6, 8, 10, 12], 12, [0, 4, 8, 12]],
    [[0, 2, 4, 6, 8, 10, 12], 13, [0, 4, 8, 12, 13]],
    [[0, 2, 4, 6, 8, 10], 13, [0, 4, 8, 10, 13]],
    [[0, 1.5, 3.8, 6.1, 8.2, 10.7, 12.4], 14, [0, 3.8, 8.2, 12.4, 14]],
    [[0, 3, 5, 7, 9], 11, [0, 3, 7, 11]],
    [[0], 2.5, [0, 2.5]],
    [[0, 2], 4, [0, 4]],
    [[0, 10, 20], 25, [0, 10, 20, 25]],
  ];
  test.each(derived)(
    "keyframes %o at duration %p",
    (keyframes, duration, expected) => {
      expect(deriveSegmentTimeline(keyframes, duration)).toEqual(expected);
    },
  );

  const invalid: [readonly number[], number][] = [
    [[], 12],
    [[2, 4], 12],
    [[0, 4, 4, 8], 12],
    [[0, 8, 4], 12],
    [[0, -2], 12],
    [[0, Number.NaN, 4], 12],
    [[0, Number.POSITIVE_INFINITY], 12],
    [[0, 15], 12],
    [[0, 4], 0],
    [[0, 4], -5],
    [[0, 4], Number.NaN],
    [[0, 4], Number.POSITIVE_INFINITY],
  ];
  test.each(invalid)(
    "rejects keyframes %o at duration %p",
    (keyframes, duration) => {
      expect(() => deriveSegmentTimeline(keyframes, duration)).toThrow(
        "Keyframes must increase from zero within a positive finite duration.",
      );
    },
  );

  test("leaves the keyframe input unchanged", () => {
    const keyframes = [0, 2, 4, 6, 8, 10, 12];
    const snapshot = structuredClone(keyframes);
    deriveSegmentTimeline(keyframes, 12);
    expect(keyframes).toEqual(snapshot);
  });
});

describe("isTimelineAligned", () => {
  const timeline = [0, 4, 8, 12];

  const aligned: [readonly number[], number, boolean][] = [
    [[0, 4, 8], 12, true],
    [[0, 2, 4, 6, 8, 10], 12, true],
    [[0, 4, 8, 12], 12, true],
    [[0, 8], 12, false],
    [[0, 4, 8], 13, false],
    [[0, 4, 8], 11, false],
    [[0, 4.000001, 8], 12, false],
  ];
  test.each(aligned)(
    "keyframes %o at duration %p",
    (keyframes, duration, expected) => {
      expect(isTimelineAligned(timeline, keyframes, duration)).toBe(expected);
    },
  );

  const malformedBoundaries: [readonly number[]][] = [
    [[]],
    [[0]],
    [[0, 8, 4, 12]],
    [[4, 8, 12]],
    [[0, 4, 8, 10]],
  ];
  test.each(malformedBoundaries)("rejects boundaries %o", (boundaries) => {
    expect(isTimelineAligned(boundaries, [0, 4, 8], 12)).toBe(false);
  });

  const malformedKeyframes: [readonly number[]][] = [
    [[]],
    [[4, 8]],
    [[0, 4, 4, 8]],
    [[0, 8, 4]],
    [[0, 4, Number.NaN]],
    [[0, 4, 15]],
  ];
  test.each(malformedKeyframes)("rejects keyframes %o", (keyframes) => {
    expect(isTimelineAligned(timeline, keyframes, 12)).toBe(false);
  });

  const roundTrips: [readonly number[], number][] = [
    [[0, 2, 4, 6, 8, 10, 12], 12],
    [[0, 2, 4, 6, 8, 10], 13],
    [[0, 1.5, 3.8, 6.1, 8.2, 10.7, 12.4], 14],
    [[0], 2.5],
  ];
  test.each(roundTrips)(
    "a derived timeline aligns with its source %o",
    (keyframes, duration) => {
      const boundaries = deriveSegmentTimeline(keyframes, duration);
      expect(isTimelineAligned(boundaries, keyframes, duration)).toBe(true);
    },
  );
});
