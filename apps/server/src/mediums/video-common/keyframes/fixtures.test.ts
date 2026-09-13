import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { withVideoFixture } from "../fixtures.ts";
import {
  createKeyframeFixture,
  ffprobeKeyframeTimes,
} from "../keyframe-fixtures.ts";
import { readKeyframeIndex } from "../keyframes.ts";

const INDEX_READ_BUDGET = 2_000_000;
const PTS_TOLERANCE = 0.000001;
const CUES_ID = Buffer.from([0x1c, 0x53, 0xbb, 0x6b]);
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

const topLevelBoxOffsets = (buffer: Buffer): Map<string, number> => {
  const offsets = new Map<string, number>();
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    if (!offsets.has(type)) {
      offsets.set(type, offset);
    }
    const small = buffer.readUInt32BE(offset);
    const size =
      small === 1
        ? Number(buffer.readBigUInt64BE(offset + 8))
        : small === 0
          ? buffer.length - offset
          : small;
    if (size < 8 || offset + size > buffer.length) {
      break;
    }
    offset += size;
  }
  return offsets;
};

describe("large fixtures", () => {
  test.each([
    ["mkv", "end"],
    ["mkv", "start"],
    ["mp4", "end"],
    ["mp4", "start"],
  ] as const)(
    "indexes a >2MB %s file with %s metadata under budget",
    async (extension, layout) => {
      await withVideoFixture(async (dir) => {
        const file = join(dir, `large.${extension}`);
        await createKeyframeFixture(file, { layout, large: true });
        expect((await stat(file)).size).toBeGreaterThan(INDEX_READ_BUDGET);

        const result = await readKeyframeIndex(file);
        const oracle = await ffprobeKeyframeTimes(file);
        if (result.keyframesSeconds === null) {
          throw new Error("expected a keyframe index");
        }
        expect(oracle.length).toBeGreaterThan(0);
        expect(result.keyframesSeconds.length).toBe(oracle.length);
        result.keyframesSeconds.forEach((actual, index) => {
          expect(
            Math.abs(actual - (oracle[index] ?? Number.NaN)),
          ).toBeLessThanOrEqual(PTS_TOLERANCE);
        });
        expect(result.bytesRead).toBeLessThan(INDEX_READ_BUDGET);

        const buffer = await readFile(file);
        if (extension === "mp4") {
          const offsets = topLevelBoxOffsets(buffer);
          const moov = offsets.get("moov");
          const mdat = offsets.get("mdat");
          if (moov === undefined || mdat === undefined) {
            throw new Error("expected moov and mdat boxes");
          }
          expect(moov).toBeGreaterThanOrEqual(0);
          expect(mdat).toBeGreaterThanOrEqual(0);
          expect(layout === "start" ? moov < mdat : moov > mdat).toBe(true);
        } else {
          const cues = buffer.lastIndexOf(CUES_ID);
          const cluster = buffer.indexOf(CLUSTER_ID);
          expect(cues).toBeGreaterThanOrEqual(0);
          expect(cluster).toBeGreaterThanOrEqual(0);
          expect(layout === "start" ? cues < cluster : cues > cluster).toBe(
            true,
          );
        }
      });
    },
  );
});
