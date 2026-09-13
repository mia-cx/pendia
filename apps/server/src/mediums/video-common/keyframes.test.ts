import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
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
  cueClusterPosition: 0xf1,
  cueRelativePosition: 0xf0,
  cueCodecState: 0xea,
  cueReference: 0xdb,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  referenceBlock: 0xfb,
  blockCodecState: 0xa4,
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

const blockHeader = (
  track: number,
  timecode: number,
  flags: number,
): number[] => [0x80 | track, (timecode >> 8) & 0xff, timecode & 0xff, flags];

const simpleBlock = (
  track: number,
  timecode: number,
  flags: number,
): number[] =>
  element(ID.simpleBlock, [...blockHeader(track, timecode, flags), 0]);

const blockGroup = (...children: number[][]): number[] =>
  element(ID.blockGroup, children.flat());

const cuePositions = (clusterAt: number, relative: number): number[] => [
  ...uintElement(ID.cueTrack, 1),
  ...uintElement(ID.cueClusterPosition, clusterAt),
  ...uintElement(ID.cueRelativePosition, relative),
];

const indexedClusterFile = (
  clusterChildren: number[][],
  cueTime: number,
  positions: (
    clusterAt: number,
    childOffset: (index: number) => number,
  ) => number[],
): Buffer => {
  const info = element(ID.info, uintElement(ID.timestampScale, 1_000_000));
  const tracks = videoTracks();
  const children = clusterChildren.flat();
  const clusterHeader =
    idBytes(ID.cluster).length + sizeBytes(children.length).length;
  const childOffset = (index: number): number =>
    clusterChildren
      .slice(0, index)
      .reduce((total, child) => total + child.length, 0);
  let at = { info: 0, tracks: 0, cues: 0 };
  for (let i = 0; i < 8; i += 1) {
    const head = element(ID.seekHead, [
      ...seekEntry(ID.info, at.info),
      ...seekEntry(ID.tracks, at.tracks),
      ...seekEntry(ID.cues, at.cues),
    ]);
    const next = {
      info: head.length,
      tracks: head.length + info.length,
      cues:
        head.length +
        info.length +
        tracks.length +
        clusterHeader +
        children.length,
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
  const head = element(ID.seekHead, [
    ...seekEntry(ID.info, at.info),
    ...seekEntry(ID.tracks, at.tracks),
    ...seekEntry(ID.cues, at.cues),
  ]);
  const clusterAt = head.length + info.length + tracks.length;
  const cues = element(
    ID.cues,
    element(ID.cuePoint, [
      ...uintElement(ID.cueTime, cueTime),
      ...element(ID.cueTrackPositions, positions(clusterAt, childOffset)),
    ]),
  );
  return segmentFile(head, info, tracks, element(ID.cluster, children), cues);
};

const bufferVintLength = (first: number): number => {
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  return length;
};

const bufferElement = (
  buf: Buffer,
  pos: number,
): { id: number; start: number; dataStart: number; dataEnd: number } => {
  const idLength = bufferVintLength(buf[pos] ?? 0);
  const id = buf.readUIntBE(pos, idLength);
  const sizeLength = bufferVintLength(buf[pos + idLength] ?? 0);
  let raw = 0n;
  for (let i = 0; i < sizeLength; i += 1) {
    raw = (raw << 8n) | BigInt(buf[pos + idLength + i] ?? 0);
  }
  const size = Number(raw & ((1n << BigInt(7 * sizeLength)) - 1n));
  return {
    id,
    start: pos,
    dataStart: pos + idLength + sizeLength,
    dataEnd: pos + idLength + sizeLength + size,
  };
};

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

  test("matches ffprobe packet keyframes with Matroska B-frames", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "bframes.mkv");
      await createKeyframeFixture(file, { bFrames: true });
      await expectKeyframeMatch(file);
    });
  });

  test("matches ffprobe packet keyframes with an audio-first Matroska track", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "audio-first.mkv");
      await createKeyframeFixture(file, { audioFirst: true });
      await expectKeyframeMatch(file);
    });
  });

  test("returns null for synthetic cues without cluster positions", async () => {
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
      await expectLazy(file);
    });
  });

  test("indexes a cue-addressed random-access SimpleBlock", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "rap-simple.mkv");
      await writeFile(
        file,
        indexedClusterFile(
          [uintElement(ID.timestamp, 0), simpleBlock(1, 0, 0x80)],
          0,
          (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
        ),
      );
      const result = await readKeyframeIndex(file);
      expect(result.keyframesSeconds).toEqual([0]);
    });
  });

  test("indexes a cue-addressed random-access BlockGroup", async () => {
    await withVideoFixture(async (dir) => {
      const file = join(dir, "rap-group.mkv");
      await writeFile(
        file,
        indexedClusterFile(
          [
            uintElement(ID.timestamp, 0),
            blockGroup(element(ID.block, blockHeader(1, 0, 0))),
          ],
          0,
          (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
        ),
      );
      const result = await readKeyframeIndex(file);
      expect(result.keyframesSeconds).toEqual([0]);
    });
  });

  test("returns null for cued blocks that are not random-access", async () => {
    await withVideoFixture(async (dir) => {
      const cases: [string, Buffer][] = [
        [
          "unflagged",
          indexedClusterFile(
            [uintElement(ID.timestamp, 0), simpleBlock(1, 0, 0)],
            0,
            (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
          ),
        ],
        [
          "laced",
          indexedClusterFile(
            [uintElement(ID.timestamp, 0), simpleBlock(1, 0, 0x86)],
            0,
            (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
          ),
        ],
        [
          "referenced-group",
          indexedClusterFile(
            [
              uintElement(ID.timestamp, 0),
              blockGroup(
                uintElement(ID.referenceBlock, 0),
                element(ID.block, blockHeader(1, 0, 0)),
              ),
            ],
            0,
            (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
          ),
        ],
        [
          "codec-state-group",
          indexedClusterFile(
            [
              uintElement(ID.timestamp, 0),
              blockGroup(
                element(ID.blockCodecState, [0]),
                element(ID.block, blockHeader(1, 0, 0)),
              ),
            ],
            0,
            (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
          ),
        ],
        [
          "time-mismatch",
          indexedClusterFile(
            [uintElement(ID.timestamp, 0), simpleBlock(1, 0, 0x80)],
            5,
            (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
          ),
        ],
        [
          "missing-relative",
          indexedClusterFile(
            [uintElement(ID.timestamp, 0), simpleBlock(1, 0, 0x80)],
            0,
            (clusterAt) => [
              ...uintElement(ID.cueTrack, 1),
              ...uintElement(ID.cueClusterPosition, clusterAt),
            ],
          ),
        ],
        [
          "missing-cluster",
          indexedClusterFile(
            [uintElement(ID.timestamp, 0), simpleBlock(1, 0, 0x80)],
            0,
            (_clusterAt, childOffset) => [
              ...uintElement(ID.cueTrack, 1),
              ...uintElement(ID.cueRelativePosition, childOffset(1)),
            ],
          ),
        ],
        [
          "referenced-cue",
          indexedClusterFile(
            [uintElement(ID.timestamp, 0), simpleBlock(1, 0, 0x80)],
            0,
            (clusterAt, childOffset) => [
              ...cuePositions(clusterAt, childOffset(1)),
              ...element(ID.cueReference, uintElement(ID.cueTime, 0)),
            ],
          ),
        ],
        [
          "wrong-track-block",
          indexedClusterFile(
            [uintElement(ID.timestamp, 0), simpleBlock(2, 0, 0x80)],
            0,
            (clusterAt, childOffset) => cuePositions(clusterAt, childOffset(1)),
          ),
        ],
      ];
      for (const [name, content] of cases) {
        const file = join(dir, `${name}.mkv`);
        await writeFile(file, content);
        await expectLazy(file);
      }
    });
  });

  test("returns null when a valid cue points at an interframe", async () => {
    await withVideoFixture(async (dir) => {
      const source = join(dir, "source.mkv");
      const remuxed = join(dir, "remuxed.mkv");
      await createKeyframeFixture(source);
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
          "-cluster_time_limit",
          "1",
          "-cluster_size_limit",
          "1000000",
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
      const segment = bufferElement(buffer, bufferElement(buffer, 0).dataEnd);
      const clusters: ReturnType<typeof bufferElement>[] = [];
      let cues: ReturnType<typeof bufferElement> | null = null;
      let cursor = segment.dataStart;
      while (cursor < buffer.length) {
        const el = bufferElement(buffer, cursor);
        if (el.id === ID.cluster) {
          clusters.push(el);
        } else if (el.id === ID.cues) {
          cues = el;
        }
        cursor = el.dataEnd;
      }
      const second = clusters[1];
      if (second === undefined || cues === null) {
        throw new Error("fixture lacks two clusters or cues");
      }
      let clusterTimestamp: number | null = null;
      let targetBlock: ReturnType<typeof bufferElement> | null = null;
      let inner = second.dataStart;
      while (inner < second.dataEnd) {
        const child = bufferElement(buffer, inner);
        if (child.id === ID.timestamp) {
          clusterTimestamp = buffer.readUIntBE(
            child.dataStart,
            child.dataEnd - child.dataStart,
          );
        } else if (child.id === ID.simpleBlock) {
          targetBlock = child;
          break;
        }
        inner = child.dataEnd;
      }
      if (clusterTimestamp === null || targetBlock === null) {
        throw new Error("fixture lacks a cluster timestamp or block");
      }
      const trackLength = bufferVintLength(buffer[targetBlock.dataStart] ?? 0);
      const track =
        (buffer[targetBlock.dataStart] ?? 0) & ((1 << (7 * trackLength)) - 1);
      const timecode = buffer.readInt16BE(targetBlock.dataStart + trackLength);
      const flags = buffer.readUInt8(targetBlock.dataStart + trackLength + 2);
      expect(track).toBe(1);
      expect(flags & 0x80).toBe(0);
      let point = bufferElement(buffer, cues.dataStart);
      while (point.id !== ID.cuePoint) {
        point = bufferElement(buffer, point.dataEnd);
      }
      let cueTimeEl: ReturnType<typeof bufferElement> | null = null;
      let positionsEl: ReturnType<typeof bufferElement> | null = null;
      let part = point.dataStart;
      while (part < point.dataEnd) {
        const el = bufferElement(buffer, part);
        if (el.id === ID.cueTime) {
          cueTimeEl = el;
        } else if (el.id === ID.cueTrackPositions) {
          positionsEl = el;
        }
        part = el.dataEnd;
      }
      if (cueTimeEl === null || positionsEl === null) {
        throw new Error("fixture lacks cue time or positions");
      }
      let clusterPosEl: ReturnType<typeof bufferElement> | null = null;
      let relativePosEl: ReturnType<typeof bufferElement> | null = null;
      let slot = positionsEl.dataStart;
      while (slot < positionsEl.dataEnd) {
        const el = bufferElement(buffer, slot);
        if (el.id === ID.cueClusterPosition) {
          clusterPosEl = el;
        } else if (el.id === ID.cueRelativePosition) {
          relativePosEl = el;
        }
        slot = el.dataEnd;
      }
      if (clusterPosEl === null || relativePosEl === null) {
        throw new Error("fixture lacks cue position fields");
      }
      const writeSameWidth = (
        el: { dataStart: number; dataEnd: number },
        value: number,
      ): void => {
        const width = el.dataEnd - el.dataStart;
        expect(value).toBeLessThan(2 ** (8 * width));
        for (let i = 0; i < width; i += 1) {
          buffer[el.dataStart + width - 1 - i] = (value >> (8 * i)) & 0xff;
        }
      };
      const newCueTime = clusterTimestamp + timecode;
      writeSameWidth(clusterPosEl, second.start - segment.dataStart);
      writeSameWidth(relativePosEl, targetBlock.start - second.dataStart);
      writeSameWidth(cueTimeEl, newCueTime);
      const patched = join(dir, "cue-interframe.mkv");
      await writeFile(patched, buffer);
      const oracle = await ffprobeKeyframeTimes(patched);
      expect(oracle).toEqual([0, 2, 4, 6, 8, 10]);
      expect(oracle).not.toContain(newCueTime / 1000);
      const result = await readKeyframeIndex(patched);
      expect(result.keyframesSeconds).toBeNull();
      expect(result.bytesRead).toBeLessThanOrEqual(INDEX_READ_BUDGET);
    });
  });

  test("returns null for a nonzero CodecDelay track", async () => {
    await withVideoFixture(async (dir) => {
      const source = join(dir, "source.mkv");
      const delayed = join(dir, "delayed.mkv");
      await createKeyframeFixture(source);
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
          "-metadata:s:v:0",
          "title=DELAYPAD",
          "-output_ts_offset",
          "1",
          delayed,
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
      const buffer = await readFile(delayed);
      const tag = Buffer.from("DELAYPAD");
      const at = buffer.indexOf(tag);
      expect(at).toBeGreaterThan(2);
      expect(buffer.lastIndexOf(tag)).toBe(at);
      expect(buffer.subarray(at - 3, at)).toEqual(
        Buffer.from([0x53, 0x6e, 0x88]),
      );
      buffer[at - 3] = 0x56;
      buffer[at - 2] = 0xaa;
      buffer.writeBigUInt64BE(1_000_000_000n, at);
      const patched = join(dir, "codec-delay.mkv");
      await writeFile(patched, buffer);
      expect(await ffprobeKeyframeTimes(patched)).toEqual([0, 2, 4, 6, 8, 10]);
      const result = await readKeyframeIndex(patched);
      expect(result.keyframesSeconds).toBeNull();
      expect(result.bytesRead).toBeLessThanOrEqual(INDEX_READ_BUDGET);
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
      await writeFile(
        file,
        segmentFile(
          element(ID.info, uintElement(ID.timestampScale, 1_000_000)),
          videoTracks(),
          element(ID.cues, cuePoint(0, 1)),
        ),
      );
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
