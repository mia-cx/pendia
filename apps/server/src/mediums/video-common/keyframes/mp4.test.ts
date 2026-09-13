import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withVideoFixture } from "../fixtures.ts";
import {
  createKeyframeFixture,
  ffprobeKeyframeTimes,
} from "../keyframe-fixtures.ts";
import { readKeyframeIndex } from "../keyframes.ts";
import { probeVideo } from "../probe.ts";

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
  id?: number;
  chapterTrackIds?: number[];
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
    ...(options.id !== undefined
      ? fullBox("tkhd", 0, [...u32(0), ...u32(0), ...u32(options.id)])
      : []),
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
    ...(options.chapterTrackIds
      ? box("tref", box("chap", options.chapterTrackIds.flatMap(u32)))
      : []),
  ]);
};

const mp4File = (moov: number[], prefix: number[] = ftypBox()): Buffer =>
  Buffer.from([...prefix, ...box("moov", moov)]);

const bufferBox = (
  buf: Buffer,
  pos: number,
): { type: string; start: number; dataStart: number; dataEnd: number } => {
  const declared = buf.readUInt32BE(pos);
  const type = buf.toString("latin1", pos + 4, pos + 8);
  const header = declared === 1 ? 16 : 8;
  const dataEnd =
    declared === 0
      ? buf.length
      : declared === 1
        ? pos + Number(buf.readBigUInt64BE(pos + 8))
        : pos + declared;
  return { type, start: pos, dataStart: pos + header, dataEnd };
};

const bufferBoxes = (
  buf: Buffer,
  start: number,
  end: number,
): ReturnType<typeof bufferBox>[] => {
  const boxes: ReturnType<typeof bufferBox>[] = [];
  let pos = start;
  while (pos < end) {
    const child = bufferBox(buf, pos);
    boxes.push(child);
    pos = child.dataEnd;
  }
  return boxes;
};

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

  test("skips chapter-referenced thumbnail tracks", async () => {
    await withVideoFixture(async (dir) => {
      const chapterFirst = join(dir, "chapter-first.mp4");
      await writeFile(
        chapterFirst,
        mp4File([
          ...timescaleBox("mvhd", 0, 1000),
          ...videoTrak({ id: 1, stss: [1], stts: [[4, 1000]] }),
          ...videoTrak({
            id: 2,
            stss: [1, 3],
            stts: [[4, 1000]],
            chapterTrackIds: [1],
          }),
        ]),
      );
      const result = await readKeyframeIndex(chapterFirst);
      expect(result.keyframesSeconds).toEqual([0, 2]);

      const chapterLater = join(dir, "chapter-later.mp4");
      await writeFile(
        chapterLater,
        mp4File([
          ...timescaleBox("mvhd", 0, 1000),
          ...videoTrak({
            id: 1,
            stss: [1, 3],
            stts: [[4, 1000]],
            chapterTrackIds: [2],
          }),
          ...videoTrak({ id: 2, stss: [1], stts: [[4, 1000]] }),
        ]),
      );
      const inverted = await readKeyframeIndex(chapterLater);
      expect(inverted.keyframesSeconds).toEqual([0, 2]);

      const onlyThumbnail = join(dir, "only-thumbnail.mp4");
      await writeFile(
        onlyThumbnail,
        mp4File([
          ...timescaleBox("mvhd", 0, 1000),
          ...videoTrak({
            id: 1,
            stss: [1],
            stts: [[4, 1000]],
            chapterTrackIds: [1],
          }),
        ]),
      );
      await expectLazy(onlyThumbnail);
    });
  });

  test("indexes the content track of a real chapter-thumbnail MP4", async () => {
    await withVideoFixture(async (dir) => {
      const first = join(dir, "first.mp4");
      const second = join(dir, "second.mp4");
      const metadata = join(dir, "chapters.txt");
      const remuxed = join(dir, "remuxed.mp4");
      await createKeyframeFixture(first, { gop: 25 });
      await createKeyframeFixture(second);
      await writeFile(
        metadata,
        ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=12000\ntitle=Opening\n",
      );
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          first,
          "-i",
          second,
          "-f",
          "ffmetadata",
          "-i",
          metadata,
          "-map",
          "0:v:0",
          "-map",
          "1:v:0",
          "-map_chapters",
          "2",
          "-c",
          "copy",
          remuxed,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, , exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`ffmpeg failed (${exitCode}): ${stderr.trim()}`);
      }
      const buffer = await readFile(remuxed);
      const moov = bufferBoxes(buffer, 0, buffer.length).find(
        (top) => top.type === "moov",
      );
      if (moov === undefined) {
        throw new Error("fixture lacks moov");
      }
      const traks = bufferBoxes(buffer, moov.dataStart, moov.dataEnd).filter(
        (child) => child.type === "trak",
      );
      const trackIds = traks.map((trak) => {
        const tkhd = bufferBoxes(buffer, trak.dataStart, trak.dataEnd).find(
          (child) => child.type === "tkhd",
        );
        if (tkhd === undefined) {
          throw new Error("fixture trak lacks tkhd");
        }
        const version = buffer[tkhd.dataStart];
        return buffer.readUInt32BE(tkhd.dataStart + (version === 0 ? 12 : 20));
      });
      const thumbnailId = trackIds[0];
      if (thumbnailId === undefined) {
        throw new Error("fixture lacks a first track");
      }
      let rewritten = 0;
      for (const trak of traks) {
        const tref = bufferBoxes(buffer, trak.dataStart, trak.dataEnd).find(
          (child) => child.type === "tref",
        );
        if (tref === undefined) {
          continue;
        }
        for (const ref of bufferBoxes(buffer, tref.dataStart, tref.dataEnd)) {
          if (ref.type !== "chap") {
            continue;
          }
          for (let at = ref.dataStart; at < ref.dataEnd; at += 4) {
            buffer.writeUInt32BE(thumbnailId, at);
            rewritten += 1;
          }
        }
      }
      expect(rewritten).toBeGreaterThan(0);
      const patched = join(dir, "thumbnail.mp4");
      await writeFile(patched, buffer);
      const probe = await probeVideo(patched);
      expect(probe.streams[0]?.disposition.attached_pic).toBe(true);
      expect(probe.streams[1]?.disposition.attached_pic).toBe(false);
      expect(probe.keyframesSeconds).toEqual([0, 2, 4, 6, 8, 10]);
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
