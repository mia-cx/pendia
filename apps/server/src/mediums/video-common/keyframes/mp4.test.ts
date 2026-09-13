import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withVideoFixture } from "../fixtures.ts";
import {
  createKeyframeFixture,
  ffprobeKeyframeTimes,
} from "../keyframe-fixtures.ts";
import { readKeyframeIndex } from "../keyframes.ts";

const INDEX_READ_BUDGET = 2_000_000;
const PTS_TOLERANCE = 0.000001;

const u16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];

const u32 = (value: number): number[] => {
  const v = value >>> 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
};

const u64 = (value: number): number[] => {
  const big = BigInt.asUintN(64, BigInt(value));
  return Array.from({ length: 8 }, (_, i) =>
    Number((big >> BigInt(8 * (7 - i))) & 0xffn),
  );
};

const ascii = (text: string): number[] =>
  [...text].map((char) => char.charCodeAt(0));

const box = (type: string, payload: number[]): number[] => [
  ...u32(8 + payload.length),
  ...ascii(type),
  ...payload,
];

const wideBox = (type: string, payload: number[]): number[] => [
  ...u32(1),
  ...ascii(type),
  ...u64(16 + payload.length),
  ...payload,
];

const fullBox = (type: string, version: number, payload: number[]): number[] =>
  box(type, [version, 0, 0, 0, ...payload]);

const ftypBox = (): number[] =>
  box("ftyp", [...ascii("isom"), ...u32(0), ...ascii("isom")]);

const timescaleBox = (
  type: "mvhd" | "mdhd",
  version: number,
  timescale: number,
): number[] =>
  fullBox(
    type,
    version,
    version === 0
      ? [...u32(0), ...u32(0), ...u32(timescale), ...u32(0)]
      : [...u64(0), ...u64(0), ...u32(timescale), ...u64(0)],
  );

const hdlrBox = (handler: string): number[] =>
  fullBox("hdlr", 0, [
    ...u32(0),
    ...ascii(handler),
    ...u32(0),
    ...u32(0),
    ...u32(0),
  ]);

const sttsBox = (runs: [number, number][]): number[] =>
  fullBox("stts", 0, [
    ...u32(runs.length),
    ...runs.flatMap(([count, delta]) => [...u32(count), ...u32(delta)]),
  ]);

const stssBox = (samples: number[]): number[] =>
  fullBox("stss", 0, [...u32(samples.length), ...samples.flatMap(u32)]);

const cttsBox = (version: number, runs: [number, number][]): number[] =>
  fullBox("ctts", version, [
    ...u32(runs.length),
    ...runs.flatMap(([count, offset]) => [...u32(count), ...u32(offset)]),
  ]);

const elstBox = (version: number, entries: [number, number][]): number[] =>
  fullBox("elst", version, [
    ...u32(entries.length),
    ...entries.flatMap(([duration, mediaTime]) =>
      version === 0
        ? [...u32(duration), ...u32(mediaTime), ...u16(1), ...u16(0)]
        : [...u64(duration), ...u64(mediaTime), ...u16(1), ...u16(0)],
    ),
  ]);

interface SyntheticTrack {
  mediaTimescale?: number;
  mdhdVersion?: number;
  stss?: number[];
  stts?: [number, number][];
  ctts?: { version: number; runs: [number, number][] };
  elst?: { version: number; entries: [number, number][] };
  tables?: number[];
}

const videoTrak = (options: SyntheticTrack): number[] => {
  const tables = options.tables ?? [
    ...(options.stts ? sttsBox(options.stts) : []),
    ...(options.stss ? stssBox(options.stss) : []),
    ...(options.ctts ? cttsBox(options.ctts.version, options.ctts.runs) : []),
  ];
  return box("trak", [
    ...box("mdia", [
      ...hdlrBox("vide"),
      ...timescaleBox(
        "mdhd",
        options.mdhdVersion ?? 0,
        options.mediaTimescale ?? 1000,
      ),
      ...box("minf", box("stbl", tables)),
    ]),
    ...(options.elst
      ? box("edts", elstBox(options.elst.version, options.elst.entries))
      : []),
  ]);
};

const mp4File = (moov: number[], prefix: number[] = ftypBox()): Buffer =>
  Buffer.from([...prefix, ...box("moov", moov)]);

const expectLazy = async (file: string): Promise<void> => {
  const result = await readKeyframeIndex(file);
  expect(result.keyframesSeconds).toBeNull();
  expect(result.bytesRead).toBeLessThanOrEqual(INDEX_READ_BUDGET);
};

const expectKeyframeMatch = async (file: string): Promise<void> => {
  const result = await readKeyframeIndex(file);
  const oracle = await ffprobeKeyframeTimes(file);
  expect(oracle.length).toBeGreaterThan(0);
  if (result.keyframesSeconds === null) {
    throw new Error("expected a keyframe index");
  }
  expect(result.keyframesSeconds.length).toBe(oracle.length);
  result.keyframesSeconds.forEach((actual, index) => {
    expect(
      Math.abs(actual - (oracle[index] ?? Number.NaN)),
    ).toBeLessThanOrEqual(PTS_TOLERANCE);
  });
  expect(result.bytesRead).toBeLessThan(INDEX_READ_BUDGET);
};

describe("readKeyframeIndex MP4", () => {
  test("matches ffprobe packet keyframes with moov at the end", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "moov-end.mp4");
      await createKeyframeFixture(file);
      await expectKeyframeMatch(file);
    });
  });

  test("matches ffprobe packet keyframes with moov at the front", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "moov-start.mp4");
      await createKeyframeFixture(file, { layout: "start" });
      await expectKeyframeMatch(file);
    });
  });

  test("matches ffprobe on a B-frame MP4 with an edit list", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "bframes.mp4");
      await createKeyframeFixture(file, { bFrames: true });
      await expectKeyframeMatch(file);
    });
  });

  test("matches ffprobe with the audio track first", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "audio-first.mp4");
      await createKeyframeFixture(file, { audioFirst: true });
      await expectKeyframeMatch(file);
    });
  });

  test("returns null for a fragmented MP4", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "fragmented.mp4");
      await createKeyframeFixture(file, { fragmented: true });
      await expectLazy(file);
    });
  });

  test("parses a moov written with extended-size boxes", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "extended.mp4");
      await writeFile(
        file,
        Buffer.from([
          ...ftypBox(),
          ...wideBox("free", Array(24).fill(0)),
          ...wideBox("moov", [
            ...timescaleBox("mvhd", 0, 1000),
            ...videoTrak({ stss: [1, 3], stts: [[4, 1000]] }),
          ]),
        ]),
      );
      const result = await readKeyframeIndex(file);
      expect(result.keyframesSeconds).toEqual([0, 2]);
      expect(result.bytesRead).toBeLessThan(INDEX_READ_BUDGET);
    });
  });

  test("applies signed version-1 ctts composition offsets", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "ctts-v1.mp4");
      await writeFile(
        file,
        mp4File([
          ...timescaleBox("mvhd", 0, 1000),
          ...videoTrak({
            stss: [1, 3],
            stts: [[4, 1000]],
            ctts: {
              version: 1,
              runs: [
                [1, 0],
                [1, 1000],
                [1, -1000],
                [1, 0],
              ],
            },
          }),
        ]),
      );
      const result = await readKeyframeIndex(file);
      expect(result.keyframesSeconds).toEqual([0, 1]);
    });
  });

  test("follows variable stts run boundaries", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "variable-stts.mp4");
      await writeFile(
        file,
        mp4File([
          ...timescaleBox("mvhd", 0, 1000),
          ...videoTrak({
            stss: [1, 3, 5],
            stts: [
              [2, 500],
              [3, 1000],
            ],
          }),
        ]),
      );
      const result = await readKeyframeIndex(file);
      expect(result.keyframesSeconds).toEqual([0, 1, 3]);
    });
  });

  test("handles version-1 mvhd, mdhd and elst", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "versioned.mp4");
      await writeFile(
        file,
        mp4File([
          ...timescaleBox("mvhd", 1, 1000),
          ...videoTrak({
            mdhdVersion: 1,
            stss: [1, 3],
            stts: [[4, 1000]],
            elst: {
              version: 1,
              entries: [
                [500, -1],
                [4000, 0],
              ],
            },
          }),
        ]),
      );
      const result = await readKeyframeIndex(file);
      expect(result.keyframesSeconds).toEqual([0.5, 2.5]);
    });
  });

  test("returns null for malformed sample tables", async () => {
    await withVideoFixture(async (dir) => {
      const cases: [string, Buffer][] = [
        [
          "stss-beyond-samples",
          mp4File([
            ...timescaleBox("mvhd", 0, 1000),
            ...videoTrak({ stss: [1, 9], stts: [[4, 1000]] }),
          ]),
        ],
        [
          "truncated-stts-count",
          mp4File([
            ...timescaleBox("mvhd", 0, 1000),
            ...videoTrak({
              tables: [
                ...fullBox("stts", 0, [...u32(5), ...u32(1), ...u32(1000)]),
                ...stssBox([1, 3]),
              ],
            }),
          ]),
        ],
        [
          "stss-version-1",
          mp4File([
            ...timescaleBox("mvhd", 0, 1000),
            ...videoTrak({
              tables: [
                ...sttsBox([[4, 1000]]),
                ...fullBox("stss", 1, [...u32(2), ...u32(1), ...u32(3)]),
              ],
            }),
          ]),
        ],
        [
          "stts-version-1",
          mp4File([
            ...timescaleBox("mvhd", 0, 1000),
            ...videoTrak({
              tables: [
                ...fullBox("stts", 1, [...u32(1), ...u32(4), ...u32(1000)]),
                ...stssBox([1, 3]),
              ],
            }),
          ]),
        ],
        [
          "zero-stts-delta",
          mp4File([
            ...timescaleBox("mvhd", 0, 1000),
            ...videoTrak({ stss: [1, 3], stts: [[4, 0]] }),
          ]),
        ],
        [
          "negative-first-ctts",
          mp4File([
            ...timescaleBox("mvhd", 0, 1000),
            ...videoTrak({
              stss: [1, 3],
              stts: [[4, 1000]],
              ctts: {
                version: 1,
                runs: [
                  [1, -500],
                  [3, 0],
                ],
              },
            }),
          ]),
        ],
      ];
      for (const [name, content] of cases) {
        const file = join(dir, `${name}.mp4`);
        await writeFile(file, content);
        await expectLazy(file);
      }
    });
  });

  test("returns null for a plain MP4 without stss", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "no-stss.mp4");
      await writeFile(
        file,
        mp4File([
          ...timescaleBox("mvhd", 0, 1000),
          ...videoTrak({ stts: [[4, 1000]] }),
        ]),
      );
      await expectLazy(file);
    });
  });
});
