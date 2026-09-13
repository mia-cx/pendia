import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withVideoFixture } from "./fixtures.ts";
import {
  createKeyframeFixture,
  ffprobeKeyframeTimes,
} from "./keyframe-fixtures.ts";
import { readKeyframeIndex } from "./keyframes.ts";

const INDEX_READ_BUDGET = 2_000_000;
const PTS_TOLERANCE = 0.000001;

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
} as const;

const idBytes = (id: number): number[] => {
  const bytes: number[] = [];
  let rest = id;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return bytes;
};

const sizeBytes = (size: number): number[] => {
  let length = 1;
  while (size >= 1 << (7 * length)) {
    length += 1;
  }
  const raw = size | (1 << (7 * length));
  return Array.from(
    { length },
    (_, i) => (raw >> (8 * (length - 1 - i))) & 0xff,
  );
};

const element = (id: number, payload: number[]): number[] => [
  ...idBytes(id),
  ...sizeBytes(payload.length),
  ...payload,
];

const uintBytes = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return bytes;
};

const uintElement = (id: number, value: number): number[] =>
  element(id, uintBytes(value));

const seekEntry = (id: number, position: number): number[] =>
  element(ID.seek, [
    ...element(ID.seekId, idBytes(id)),
    ...uintElement(ID.seekPosition, position),
  ]);

const segmentStart = [...element(ID.ebml, []), ...idBytes(ID.segment), 0xff];

const segmentFile = (...children: number[][]): Buffer =>
  Buffer.from([...segmentStart, ...children.flat()]);

const cuePoint = (time: number, track: number): number[] =>
  element(ID.cuePoint, [
    ...uintElement(ID.cueTime, time),
    ...element(ID.cueTrackPositions, uintElement(ID.cueTrack, track)),
  ]);

const videoTracks = (): number[] =>
  element(ID.tracks, [
    ...element(ID.trackEntry, [
      ...uintElement(ID.trackNumber, 1),
      ...uintElement(ID.trackType, 1),
    ]),
  ]);

const seekHeadFile = (
  info: number[],
  tracks: number[],
  cues: number[],
): Buffer => {
  const build = (at: {
    info: number;
    tracks: number;
    cues: number;
  }): number[] =>
    element(ID.seekHead, [
      ...seekEntry(ID.info, at.info),
      ...seekEntry(ID.tracks, at.tracks),
      ...seekEntry(ID.cues, at.cues),
    ]);
  let at = { info: 0, tracks: 0, cues: 0 };
  for (let i = 0; i < 8; i += 1) {
    const head = build(at);
    const next = {
      info: head.length,
      tracks: head.length + info.length,
      cues: head.length + info.length + tracks.length,
    };
    if (
      next.info === at.info &&
      next.tracks === at.tracks &&
      next.cues === at.cues
    ) {
      break;
    }
    at = next;
  }
  return segmentFile(build(at), info, tracks, cues);
};

const remuxLive = async (source: string, target: string): Promise<void> => {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-c",
      "copy",
      "-live",
      "1",
      target,
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
};

const expectLazy = async (file: string): Promise<void> => {
  const result = await readKeyframeIndex(file);
  expect(result.keyframesSeconds).toBeNull();
  expect(result.bytesRead).toBeLessThanOrEqual(INDEX_READ_BUDGET);
};

const expectKeyframeMatch = async (file: string): Promise<void> => {
  const result = await readKeyframeIndex(file);
  const oracle = await ffprobeKeyframeTimes(file);
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

describe("readKeyframeIndex", () => {
  test("matches ffprobe packet keyframes with cues at the end", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "cues-end.mkv");
      await createKeyframeFixture(file);
      await expectKeyframeMatch(file);
    });
  });

  test("matches ffprobe packet keyframes with cues at the front", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "cues-start.mkv");
      await createKeyframeFixture(file, { layout: "start" });
      await expectKeyframeMatch(file);
    });
  });

  test("reads keyframes from a synthetic SeekHead and Cues file", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "synthetic.mkv");
      await writeFile(
        file,
        seekHeadFile(
          element(ID.info, uintElement(ID.timestampScale, 1_000_000)),
          videoTracks(),
          element(ID.cues, [
            ...cuePoint(0, 1),
            ...cuePoint(2_000, 1),
            ...cuePoint(4_000, 1),
          ]),
        ),
      );
      const result = await readKeyframeIndex(file);
      expect(result.keyframesSeconds).toEqual([0, 2, 4]);
      expect(result.bytesRead).toBeLessThan(INDEX_READ_BUDGET);
    });
  });

  test("returns null for a Matroska file without cues", async () => {
    await withVideoFixture(async (dir) => {
      const source = join(dir, "source.mkv");
      const file = join(dir, "live.mkv");
      await createKeyframeFixture(source);
      await remuxLive(source, file);
      await expectLazy(file);
    });
  });

  test("returns null for front Cues that no SeekHead reaches", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "unreachable-cues.mkv");
      await writeFile(file, segmentFile(element(ID.cues, cuePoint(0, 1))));
      await expectLazy(file);
    });
  });

  test("returns null for a zero TimestampScale", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "zero-scale.mkv");
      await writeFile(
        file,
        seekHeadFile(
          element(ID.info, uintElement(ID.timestampScale, 0)),
          videoTracks(),
          element(ID.cues, cuePoint(0, 1)),
        ),
      );
      await expectLazy(file);
    });
  });

  test("returns null for truncated and malformed EBML", async () => {
    await withVideoFixture(async (dir) => {
      const signatureOnly = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
      const truncatedPayload = Buffer.from([
        0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x02,
      ]);
      const cutSegmentHeader = Buffer.from([
        ...element(ID.ebml, []),
        ...idBytes(ID.segment),
        0x88,
      ]);
      const cyclicSeekHead = segmentFile(
        element(ID.seekHead, seekEntry(ID.seekHead, 0)),
      );
      const outOfRangeSeek = segmentFile(
        element(ID.seekHead, seekEntry(ID.cues, 0xffff)),
      );
      const unknownSizeSeekHead = segmentFile([...idBytes(ID.seekHead), 0xff]);
      const oversizedInteger = segmentFile(
        element(
          ID.seekHead,
          element(ID.seek, [
            ...element(ID.seekId, idBytes(ID.info)),
            ...element(ID.seekPosition, Array(9).fill(0)),
          ]),
        ),
      );
      const overBudgetSeekHead = Buffer.concat([
        Buffer.from([
          ...segmentStart,
          ...idBytes(ID.seekHead),
          ...sizeBytes(INDEX_READ_BUDGET + 1),
        ]),
        Buffer.alloc(INDEX_READ_BUDGET + 1),
      ]);
      const cases = [
        signatureOnly,
        truncatedPayload,
        cutSegmentHeader,
        cyclicSeekHead,
        outOfRangeSeek,
        unknownSizeSeekHead,
        oversizedInteger,
        overBudgetSeekHead,
      ];
      for (const [index, content] of cases.entries()) {
        const file = join(dir, `corrupt-${index}.mkv`);
        await writeFile(file, content);
        await expectLazy(file);
      }
    });
  });

  test("returns null for an MP4 signature and non-media content", async () => {
    await withVideoFixture(async (dir) => {
      const mp4 = join(dir, "video.mp4");
      await writeFile(
        mp4,
        Buffer.from([
          0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f,
          0x6d, 0x00, 0x00, 0x00, 0x00,
        ]),
      );
      await expectLazy(mp4);

      const notes = join(dir, "notes.mkv");
      await writeFile(notes, "not media\n");
      await expectLazy(notes);
    });
  });

  test("rejects a nonexistent file", async () => {
    await withVideoFixture(async (dir) => {
      await expect(
        readKeyframeIndex(join(dir, "missing.mkv")),
      ).rejects.toThrow();
    });
  });
});
