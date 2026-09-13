import { INDEX_READ_BUDGET, type IndexReader, InvalidIndex } from "./reader.ts";

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_TRACK_TIMESTAMP_SCALE = 0x23314f;
const ID_CODEC_DELAY = 0x56aa;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
const ID_CUE_RELATIVE_POSITION = 0xf0;
const ID_CUE_CODEC_STATE = 0xea;
const ID_CUE_REFERENCE = 0xdb;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;
const ID_BLOCK_CODEC_STATE = 0xa4;

const TRACK_TYPE_VIDEO = 1;
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

interface ElementRange {
  id: number;
  start: number;
  dataStart: number;
  dataEnd: number | null;
}

const invalid = (message: string): InvalidIndex => new InvalidIndex(message);

const vintLength = (first: number): number => {
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  return length > 8 ? 0 : length;
};

const bigUintAt = (buf: Buffer, offset: number, length: number): bigint => {
  let value = 0n;
  for (const byte of buf.subarray(offset, offset + length)) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
};

const uintAt = (buf: Buffer, offset: number, length: number): number => {
  if (length < 0 || length > 8) {
    throw invalid("integer element too large");
  }
  const value = bigUintAt(buf, offset, length);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid("integer element too large");
  }
  return Number(value);
};

const floatAt = (buf: Buffer, el: ElementRange): number => {
  const length = (el.dataEnd ?? buf.length) - el.dataStart;
  if (length === 4) {
    return buf.readFloatBE(el.dataStart);
  }
  if (length === 8) {
    return buf.readDoubleBE(el.dataStart);
  }
  if (length === 0) {
    return 0;
  }
  throw invalid("bad float element");
};

const parseHeader = (
  buf: Buffer,
  pos: number,
  limit: number,
): { id: number; headerLength: number; size: number | null } => {
  if (pos < 0 || pos >= limit || limit > buf.length) {
    throw invalid("element header out of bounds");
  }
  const idLength = vintLength(buf[pos] ?? 0);
  if (idLength === 0 || idLength > 4 || pos + idLength + 1 > limit) {
    throw invalid("truncated element id");
  }
  const id = uintAt(buf, pos, idLength);
  const sizeStart = pos + idLength;
  const sizeLength = vintLength(buf[sizeStart] ?? 0);
  if (sizeLength === 0 || sizeStart + sizeLength > limit) {
    throw invalid("truncated element size");
  }
  const raw = bigUintAt(buf, sizeStart, sizeLength);
  const capacity = (1n << BigInt(7 * sizeLength)) - 1n;
  const value = raw & capacity;
  let size: number | null = null;
  if (value !== capacity) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalid("element size too large");
    }
    size = Number(value);
  }
  return { id, headerLength: idLength + sizeLength, size };
};

const readElementHeader = async (
  reader: IndexReader,
  pos: number,
  parentEnd: number,
): Promise<ElementRange> => {
  if (pos < 0 || pos >= parentEnd) {
    throw invalid("element header out of bounds");
  }
  const idFirst = await reader.read(pos, 1);
  const idLength = vintLength(idFirst[0] ?? 0);
  if (idLength === 0 || idLength > 4 || pos + idLength >= parentEnd) {
    throw invalid("truncated element id");
  }
  const sizeFirst = await reader.read(pos + idLength, 1);
  const sizeLength = vintLength(sizeFirst[0] ?? 0);
  if (sizeLength === 0 || pos + idLength + sizeLength > parentEnd) {
    throw invalid("truncated element size");
  }
  const buf = await reader.read(pos, idLength + sizeLength);
  const header = parseHeader(buf, 0, buf.length);
  const dataStart = pos + header.headerLength;
  if (header.size !== null && header.size > parentEnd - dataStart) {
    throw invalid("element exceeds its parent");
  }
  return {
    id: header.id,
    start: pos,
    dataStart,
    dataEnd: header.size === null ? null : dataStart + header.size,
  };
};

const childElements = function* (buf: Buffer): Generator<ElementRange> {
  let pos = 0;
  while (pos < buf.length) {
    const header = parseHeader(buf, pos, buf.length);
    if (header.size === null) {
      throw invalid("unknown-size child element");
    }
    const dataStart = pos + header.headerLength;
    if (header.size > buf.length - dataStart) {
      throw invalid("element exceeds its parent");
    }
    yield {
      id: header.id,
      start: pos,
      dataStart,
      dataEnd: dataStart + header.size,
    };
    pos = dataStart + header.size;
  }
};

const payloadView = (buf: Buffer, el: ElementRange): Buffer =>
  buf.subarray(el.dataStart, el.dataEnd ?? buf.length);

const elementUint = (buf: Buffer, el: ElementRange): number =>
  uintAt(buf, el.dataStart, (el.dataEnd ?? buf.length) - el.dataStart);

const readElementPayload = async (
  reader: IndexReader,
  el: ElementRange,
): Promise<Buffer> => {
  if (el.dataEnd === null) {
    throw invalid("unknown-size element payload");
  }
  const length = el.dataEnd - el.dataStart;
  if (length < 0 || length > INDEX_READ_BUDGET) {
    throw invalid("element payload too large");
  }
  const buf = await reader.read(el.dataStart, length);
  if (buf.length !== length) {
    throw invalid("truncated element payload");
  }
  return buf;
};

const timestampScale = async (
  reader: IndexReader,
  at: number | undefined,
  segmentEnd: number,
): Promise<number> => {
  if (at === undefined) {
    return DEFAULT_TIMESTAMP_SCALE;
  }
  const el = await readElementHeader(reader, at, segmentEnd);
  if (el.id !== ID_INFO) {
    throw invalid("seek target id mismatch");
  }
  const view = await readElementPayload(reader, el);
  let scale = DEFAULT_TIMESTAMP_SCALE;
  for (const child of childElements(view)) {
    if (child.id === ID_TIMESTAMP_SCALE) {
      scale = elementUint(view, child);
    }
  }
  return scale;
};

const selectVideoTrack = async (
  reader: IndexReader,
  at: number,
  segmentEnd: number,
): Promise<{
  trackNumber: number;
  trackScale: number;
  codecDelay: number;
}> => {
  const el = await readElementHeader(reader, at, segmentEnd);
  if (el.id !== ID_TRACKS) {
    throw invalid("seek target id mismatch");
  }
  const view = await readElementPayload(reader, el);
  for (const entry of childElements(view)) {
    if (entry.id !== ID_TRACK_ENTRY) {
      continue;
    }
    const entryView = payloadView(view, entry);
    let number: number | null = null;
    let type: number | null = null;
    let scale = 1;
    let codecDelay = 0;
    for (const field of childElements(entryView)) {
      if (field.id === ID_TRACK_NUMBER) {
        number = elementUint(entryView, field);
      } else if (field.id === ID_TRACK_TYPE) {
        type = elementUint(entryView, field);
      } else if (field.id === ID_TRACK_TIMESTAMP_SCALE) {
        scale = floatAt(entryView, field);
      } else if (field.id === ID_CODEC_DELAY) {
        codecDelay = elementUint(entryView, field);
      }
    }
    if (type === TRACK_TYPE_VIDEO) {
      if (number === null || number <= 0) {
        throw invalid("video track without a track number");
      }
      return { trackNumber: number, trackScale: scale, codecDelay };
    }
  }
  throw invalid("no video track");
};

const readBlockPrefix = async (
  reader: IndexReader,
  el: ElementRange,
): Promise<{ track: number; timecode: number; flags: number }> => {
  if (el.dataEnd === null) {
    throw invalid("unknown-size block");
  }
  const first = await reader.read(el.dataStart, 1);
  const trackLength = vintLength(first[0] ?? 0);
  if (trackLength === 0 || el.dataStart + trackLength + 3 > el.dataEnd) {
    throw invalid("truncated block header");
  }
  const buf = await reader.read(el.dataStart, trackLength + 3);
  if (buf.length !== trackLength + 3) {
    throw invalid("truncated block header");
  }
  const capacity = (1n << BigInt(7 * trackLength)) - 1n;
  const track = Number(bigUintAt(buf, 0, trackLength) & capacity);
  if (!Number.isSafeInteger(track) || track === 0) {
    throw invalid("bad block track number");
  }
  return {
    track,
    timecode: buf.readInt16BE(trackLength),
    flags: buf.readUInt8(trackLength + 2),
  };
};

const isRandomAccessCue = async (
  reader: IndexReader,
  segmentStart: number,
  segmentEnd: number,
  clusterPosition: number,
  relativePosition: number,
  trackNumber: number,
  cueTime: number,
): Promise<boolean> => {
  const cluster = await readElementHeader(
    reader,
    segmentStart + clusterPosition,
    segmentEnd,
  );
  if (cluster.id !== ID_CLUSTER || cluster.dataEnd === null) {
    return false;
  }
  const clusterEnd = cluster.dataEnd;
  const target = cluster.dataStart + relativePosition;
  if (target >= clusterEnd) {
    return false;
  }
  let clusterTimestamp: number | null = null;
  let firstBlock = -1;
  let cursor = cluster.dataStart;
  while (cursor < clusterEnd) {
    const child = await readElementHeader(reader, cursor, clusterEnd);
    if (child.dataEnd === null) {
      throw invalid("unknown-size Cluster child");
    }
    if (child.id === ID_CLUSTER_TIMESTAMP) {
      const payload = await readElementPayload(reader, child);
      clusterTimestamp = uintAt(payload, 0, payload.length);
    } else if (child.id === ID_SIMPLE_BLOCK || child.id === ID_BLOCK_GROUP) {
      firstBlock = child.start;
      break;
    }
    cursor = child.dataEnd;
  }
  if (clusterTimestamp === null || firstBlock < 0 || target < firstBlock) {
    return false;
  }
  const targetEl = await readElementHeader(reader, target, clusterEnd);
  if (targetEl.id === ID_SIMPLE_BLOCK) {
    const prefix = await readBlockPrefix(reader, targetEl);
    if (
      prefix.track !== trackNumber ||
      (prefix.flags & 0x80) === 0 ||
      (prefix.flags & 0x06) !== 0
    ) {
      return false;
    }
    return clusterTimestamp + prefix.timecode === cueTime;
  }
  if (targetEl.id === ID_BLOCK_GROUP) {
    const groupEnd = targetEl.dataEnd;
    if (groupEnd === null) {
      return false;
    }
    let blocks = 0;
    let timecode = 0;
    let groupCursor = targetEl.dataStart;
    while (groupCursor < groupEnd) {
      const child = await readElementHeader(reader, groupCursor, groupEnd);
      if (child.dataEnd === null) {
        throw invalid("unknown-size BlockGroup child");
      }
      if (child.id === ID_BLOCK) {
        const prefix = await readBlockPrefix(reader, child);
        if (prefix.track !== trackNumber || (prefix.flags & 0x06) !== 0) {
          return false;
        }
        blocks += 1;
        timecode = prefix.timecode;
      } else if (
        child.id === ID_REFERENCE_BLOCK ||
        child.id === ID_BLOCK_CODEC_STATE
      ) {
        return false;
      }
      groupCursor = child.dataEnd;
    }
    if (blocks !== 1) {
      return false;
    }
    return clusterTimestamp + timecode === cueTime;
  }
  return false;
};

const cueSeconds = async (
  reader: IndexReader,
  segmentStart: number,
  at: number,
  segmentEnd: number,
  trackNumber: number,
  scale: number,
): Promise<number[]> => {
  const el = await readElementHeader(reader, at, segmentEnd);
  if (el.id !== ID_CUES) {
    throw invalid("seek target id mismatch");
  }
  const view = await readElementPayload(reader, el);
  const seconds = new Set<number>();
  for (const point of childElements(view)) {
    if (point.id !== ID_CUE_POINT) {
      continue;
    }
    const pointView = payloadView(view, point);
    let cueTime: number | null = null;
    let onTrack = false;
    let clusterPosition: number | null = null;
    let relativePosition: number | null = null;
    for (const part of childElements(pointView)) {
      if (part.id === ID_CUE_TIME) {
        cueTime = elementUint(pointView, part);
      } else if (part.id === ID_CUE_TRACK_POSITIONS) {
        const positionsView = payloadView(pointView, part);
        let track: number | null = null;
        let cluster: number | null = null;
        let relative: number | null = null;
        let codecState = 0;
        let hasReference = false;
        for (const position of childElements(positionsView)) {
          if (position.id === ID_CUE_TRACK) {
            track = elementUint(positionsView, position);
          } else if (position.id === ID_CUE_CLUSTER_POSITION) {
            cluster = elementUint(positionsView, position);
          } else if (position.id === ID_CUE_RELATIVE_POSITION) {
            relative = elementUint(positionsView, position);
          } else if (position.id === ID_CUE_CODEC_STATE) {
            codecState = elementUint(positionsView, position);
          } else if (position.id === ID_CUE_REFERENCE) {
            hasReference = true;
          }
        }
        if (track !== trackNumber) {
          continue;
        }
        onTrack = true;
        if (
          cluster === null ||
          relative === null ||
          codecState !== 0 ||
          hasReference
        ) {
          throw invalid("unsupported cue positions");
        }
        clusterPosition = cluster;
        relativePosition = relative;
      }
    }
    if (!onTrack) {
      continue;
    }
    if (
      cueTime === null ||
      clusterPosition === null ||
      relativePosition === null
    ) {
      throw invalid("selected cue is incomplete");
    }
    if (
      !(await isRandomAccessCue(
        reader,
        segmentStart,
        segmentEnd,
        clusterPosition,
        relativePosition,
        trackNumber,
        cueTime,
      ))
    ) {
      throw invalid("cue target is not a random-access point");
    }
    const value = (cueTime * scale) / 1e9;
    if (Number.isFinite(value) && value >= 0) {
      seconds.add(value);
    }
  }
  return [...seconds].sort((a, b) => a - b);
};

/** Read keyframe seconds from Matroska SeekHead and Cues elements. */
export async function readMatroskaKeyframes(
  reader: IndexReader,
): Promise<number[] | null> {
  const first = await readElementHeader(reader, 0, reader.size);
  if (first.id !== ID_EBML || first.dataEnd === null) {
    throw invalid("missing EBML header");
  }
  let segment: ElementRange | null = null;
  let pos = first.dataEnd;
  while (pos < reader.size) {
    const el = await readElementHeader(reader, pos, reader.size);
    if (el.id === ID_SEGMENT) {
      segment = el;
      break;
    }
    if (el.dataEnd === null) {
      throw invalid("unknown-size top-level element");
    }
    pos = el.dataEnd;
  }
  if (segment === null) {
    throw invalid("missing Segment element");
  }
  const segmentStart = segment.dataStart;
  const segmentEnd = segment.dataEnd ?? reader.size;

  const found = new Map<number, number>();
  const seekHeads: number[] = [];
  let cursor = segmentStart;
  while (cursor < segmentEnd) {
    const el = await readElementHeader(reader, cursor, segmentEnd);
    if (el.id === ID_CLUSTER) {
      break;
    }
    if (el.dataEnd === null) {
      throw invalid("unknown-size Segment child");
    }
    if (el.id === ID_SEEK_HEAD) {
      seekHeads.push(el.start);
    } else if (
      (el.id === ID_INFO || el.id === ID_TRACKS) &&
      !found.has(el.id)
    ) {
      found.set(el.id, el.start);
    }
    cursor = el.dataEnd;
    if (seekHeads.length > 0 && found.has(ID_INFO) && found.has(ID_TRACKS)) {
      break;
    }
  }

  const visited = new Set<number>();
  const pending = [...seekHeads];
  while (pending.length > 0) {
    const at = pending.shift();
    if (at === undefined || visited.has(at)) {
      continue;
    }
    visited.add(at);
    const head = await readElementHeader(reader, at, segmentEnd);
    if (head.id !== ID_SEEK_HEAD) {
      throw invalid("seek target is not a SeekHead");
    }
    const view = await readElementPayload(reader, head);
    for (const seek of childElements(view)) {
      if (seek.id !== ID_SEEK) {
        continue;
      }
      const seekView = payloadView(view, seek);
      let seekId: number | null = null;
      let seekPosition: number | null = null;
      for (const field of childElements(seekView)) {
        if (field.id === ID_SEEK_ID) {
          seekId = elementUint(seekView, field);
        } else if (field.id === ID_SEEK_POSITION) {
          seekPosition = elementUint(seekView, field);
        }
      }
      if (seekId === null || seekPosition === null) {
        throw invalid("incomplete Seek entry");
      }
      const target = segmentStart + seekPosition;
      if (target >= segmentEnd) {
        throw invalid("seek target outside Segment");
      }
      const targetEl = await readElementHeader(reader, target, segmentEnd);
      if (targetEl.id !== seekId) {
        throw invalid("seek target id mismatch");
      }
      if (seekId === ID_SEEK_HEAD) {
        if (!visited.has(target)) {
          pending.push(target);
        }
      } else if (
        (seekId === ID_INFO || seekId === ID_TRACKS || seekId === ID_CUES) &&
        !found.has(seekId)
      ) {
        found.set(seekId, target);
      }
    }
  }

  const tracksAt = found.get(ID_TRACKS);
  const cuesAt = found.get(ID_CUES);
  if (tracksAt === undefined || cuesAt === undefined) {
    return null;
  }
  const scale = await timestampScale(reader, found.get(ID_INFO), segmentEnd);
  const { trackNumber, trackScale, codecDelay } = await selectVideoTrack(
    reader,
    tracksAt,
    segmentEnd,
  );
  if (trackScale !== 1 || scale <= 0 || codecDelay !== 0) {
    return null;
  }
  const seconds = await cueSeconds(
    reader,
    segmentStart,
    cuesAt,
    segmentEnd,
    trackNumber,
    scale,
  );
  return seconds.length > 0 ? seconds : null;
}
