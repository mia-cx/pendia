import { INDEX_READ_BUDGET, type IndexReader, InvalidIndex } from "./reader.ts";

const invalid = (message: string): InvalidIndex => new InvalidIndex(message);

interface Box {
  type: string;
  dataStart: number;
  dataEnd: number;
}

interface TimingRun {
  count: number;
  value: number;
}

interface EditShape {
  emptyDuration: number;
  mediaTime: number;
  mediaDuration: number | null;
}

const readBoxHeader = async (
  reader: IndexReader,
  pos: number,
  parentEnd: number,
): Promise<Box> => {
  if (pos < 0 || pos + 8 > parentEnd) {
    throw invalid("box header out of bounds");
  }
  const head = await reader.read(pos, 8);
  if (head.length < 8) {
    throw invalid("truncated box header");
  }
  const declared = head.readUInt32BE(0);
  const type = head.toString("latin1", 4, 8);
  if (declared === 0) {
    return { type, dataStart: pos + 8, dataEnd: parentEnd };
  }
  let headerSize = 8;
  let size = declared;
  if (declared === 1) {
    if (pos + 16 > parentEnd) {
      throw invalid("truncated extended box size");
    }
    const extended = await reader.read(pos + 8, 8);
    if (extended.length < 8) {
      throw invalid("truncated extended box size");
    }
    const wide = extended.readBigUInt64BE(0);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalid("box size too large");
    }
    size = Number(wide);
    headerSize = 16;
  }
  if (size < headerSize || size > parentEnd - pos) {
    throw invalid("box exceeds its parent");
  }
  return { type, dataStart: pos + headerSize, dataEnd: pos + size };
};

const childBoxes = async function* (
  reader: IndexReader,
  parent: Box,
): AsyncGenerator<Box> {
  let pos = parent.dataStart;
  while (pos < parent.dataEnd) {
    const child = await readBoxHeader(reader, pos, parent.dataEnd);
    yield child;
    pos = child.dataEnd;
  }
};

const boxPayload = async (reader: IndexReader, box: Box): Promise<Buffer> => {
  const length = box.dataEnd - box.dataStart;
  if (length > INDEX_READ_BUDGET) {
    throw invalid("box payload too large");
  }
  const buf = await reader.read(box.dataStart, length);
  if (buf.length !== length) {
    throw invalid("truncated box payload");
  }
  return buf;
};

const firstChild = async (
  reader: IndexReader,
  parent: Box,
  type: string,
): Promise<Box | null> => {
  for await (const child of childBoxes(reader, parent)) {
    if (child.type === type) {
      return child;
    }
  }
  return null;
};

const timescaleOf = (buf: Buffer, box: string): number => {
  if (buf.length < 4) {
    throw invalid(`truncated ${box}`);
  }
  const version = buf.readUInt8(0);
  const offset = version === 0 ? 12 : version === 1 ? 20 : null;
  if (offset === null || buf.length < offset + 4) {
    throw invalid(`unsupported ${box} version`);
  }
  const timescale = buf.readUInt32BE(offset);
  if (timescale <= 0) {
    throw invalid(`invalid ${box} timescale`);
  }
  return timescale;
};

const handlerType = (buf: Buffer): string => {
  if (buf.length < 12) {
    throw invalid("truncated hdlr");
  }
  return buf.toString("latin1", 8, 12);
};

const safeInt64 = (buf: Buffer, at: number): number => {
  const value = buf.readBigInt64BE(at);
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw invalid("integer too large");
  }
  return Number(value);
};

const safeUint64 = (buf: Buffer, at: number): number => {
  const value = buf.readBigUInt64BE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid("integer too large");
  }
  return Number(value);
};

const tableRuns = (buf: Buffer, box: string, signed: boolean): TimingRun[] => {
  if (buf.length < 8) {
    throw invalid(`truncated ${box}`);
  }
  if (box === "stts" && buf.readUInt8(0) !== 0) {
    throw invalid("unsupported stts version");
  }
  const count = buf.readUInt32BE(4);
  if (count * 8 > buf.length - 8) {
    throw invalid(`${box} count exceeds payload`);
  }
  const runs: TimingRun[] = [];
  for (let i = 0; i < count; i += 1) {
    const runCount = buf.readUInt32BE(8 + i * 8);
    if (runCount === 0) {
      throw invalid(`${box} zero run count`);
    }
    const value = signed
      ? buf.readInt32BE(12 + i * 8)
      : buf.readUInt32BE(12 + i * 8);
    if (box === "stts" && value === 0) {
      throw invalid("zero sample duration");
    }
    runs.push({ count: runCount, value });
  }
  return runs;
};

const compositionRuns = (buf: Buffer): TimingRun[] => {
  if (buf.length < 4) {
    throw invalid("truncated ctts");
  }
  const version = buf.readUInt8(0);
  if (version !== 0 && version !== 1) {
    throw invalid("unsupported ctts version");
  }
  return tableRuns(buf, "ctts", version === 1);
};

const syncSamples = (buf: Buffer): number[] => {
  if (buf.length < 8) {
    throw invalid("truncated stss");
  }
  if (buf.readUInt8(0) !== 0) {
    throw invalid("unsupported stss version");
  }
  const count = buf.readUInt32BE(4);
  if (count * 4 > buf.length - 8) {
    throw invalid("stss count exceeds payload");
  }
  const samples: number[] = [];
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = buf.readUInt32BE(8 + i * 4);
    if (sample <= previous) {
      throw invalid("stss not strictly increasing");
    }
    samples.push(sample);
    previous = sample;
  }
  return samples;
};

const editList = (buf: Buffer): EditShape | null => {
  if (buf.length < 8) {
    throw invalid("truncated elst");
  }
  const version = buf.readUInt8(0);
  const entrySize = version === 0 ? 12 : version === 1 ? 20 : null;
  if (entrySize === null) {
    return null;
  }
  const count = buf.readUInt32BE(4);
  if (count * entrySize > buf.length - 8) {
    throw invalid("elst count exceeds payload");
  }
  if (count === 0) {
    return { emptyDuration: 0, mediaTime: 0, mediaDuration: null };
  }
  let emptyDuration = 0;
  let media: { time: number; duration: number } | null = null;
  for (let i = 0; i < count; i += 1) {
    const at = 8 + i * entrySize;
    const duration = version === 0 ? buf.readUInt32BE(at) : safeUint64(buf, at);
    const mediaTime =
      version === 0 ? buf.readInt32BE(at + 4) : safeInt64(buf, at + 8);
    if (
      buf.readInt16BE(at + entrySize - 4) !== 1 ||
      buf.readUInt16BE(at + entrySize - 2) !== 0
    ) {
      return null;
    }
    if (mediaTime === -1) {
      if (media !== null) {
        return null;
      }
      emptyDuration += duration;
      if (!Number.isSafeInteger(emptyDuration)) {
        throw invalid("edit duration overflow");
      }
    } else if (mediaTime >= 0) {
      if (media !== null) {
        return null;
      }
      media = { time: mediaTime, duration };
    } else {
      return null;
    }
  }
  if (media === null) {
    return null;
  }
  return {
    emptyDuration,
    mediaTime: media.time,
    mediaDuration: media.duration,
  };
};

class RunCursor {
  private entryIndex = 0;
  private runStart = 0;
  private runTime = 0;

  constructor(
    private readonly runs: readonly TimingRun[],
    private readonly sum: boolean,
  ) {}

  private seekTo(sample: number): TimingRun {
    let run = this.runs[this.entryIndex];
    while (run !== undefined && sample >= this.runStart + run.count) {
      if (this.sum) {
        this.runTime += run.count * run.value;
        if (!Number.isSafeInteger(this.runTime)) {
          throw invalid("time overflow");
        }
      }
      this.runStart += run.count;
      this.entryIndex += 1;
      run = this.runs[this.entryIndex];
    }
    if (run === undefined || sample < this.runStart) {
      throw invalid("sample index out of range");
    }
    return run;
  }

  decodeTimeAt(sample: number): number {
    const run = this.seekTo(sample);
    const time = this.runTime + (sample - this.runStart) * run.value;
    if (!Number.isSafeInteger(time)) {
      throw invalid("time overflow");
    }
    return time;
  }

  offsetAt(sample: number): number {
    return this.seekTo(sample).value;
  }
}

const readTrakKeyframes = async (
  reader: IndexReader,
  trak: Box,
  movieTimescale: number | null,
): Promise<number[] | null | undefined> => {
  const mdia = await firstChild(reader, trak, "mdia");
  if (mdia === null) {
    return undefined;
  }
  const edts = await firstChild(reader, trak, "edts");

  let handler: string | null = null;
  let mediaTimescale: number | null = null;
  let minf: Box | null = null;
  for await (const child of childBoxes(reader, mdia)) {
    if (child.type === "hdlr") {
      handler = handlerType(await boxPayload(reader, child));
    } else if (child.type === "mdhd") {
      mediaTimescale = timescaleOf(await boxPayload(reader, child), "mdhd");
    } else if (child.type === "minf") {
      minf = child;
    }
  }
  if (handler !== "vide") {
    return undefined;
  }
  if (mediaTimescale === null || minf === null) {
    return null;
  }
  const stbl = await firstChild(reader, minf, "stbl");
  if (stbl === null) {
    return null;
  }
  let stss: Box | null = null;
  let stts: Box | null = null;
  let ctts: Box | null = null;
  for await (const child of childBoxes(reader, stbl)) {
    if (child.type === "stss") {
      stss = child;
    } else if (child.type === "stts") {
      stts = child;
    } else if (child.type === "ctts") {
      ctts = child;
    }
  }
  if (stss === null || stts === null) {
    return null;
  }
  const sync = syncSamples(await boxPayload(reader, stss));
  const timing = tableRuns(await boxPayload(reader, stts), "stts", false);
  if (sync.length === 0 || timing.length === 0) {
    return null;
  }
  const totalSamples = timing.reduce((sum, run) => sum + run.count, 0);
  if (!Number.isSafeInteger(totalSamples)) {
    throw invalid("sample count overflow");
  }
  const lastSync = sync[sync.length - 1] ?? 0;
  if (lastSync > totalSamples) {
    throw invalid("stss beyond sample count");
  }
  const offsets =
    ctts === null ? null : compositionRuns(await boxPayload(reader, ctts));
  if (
    offsets !== null &&
    offsets.reduce((sum, run) => sum + run.count, 0) !== totalSamples
  ) {
    throw invalid("ctts sample count mismatch");
  }

  let edit: EditShape = {
    emptyDuration: 0,
    mediaTime: 0,
    mediaDuration: null,
  };
  if (edts !== null) {
    const elst = await firstChild(reader, edts, "elst");
    if (elst !== null) {
      const parsed = editList(await boxPayload(reader, elst));
      if (parsed === null) {
        return null;
      }
      edit = parsed;
    }
  }
  if (
    (edit.emptyDuration > 0 || edit.mediaDuration !== null) &&
    (movieTimescale === null || movieTimescale <= 0)
  ) {
    return null;
  }
  const movieScale = movieTimescale ?? 1;
  const emptySeconds = edit.emptyDuration / movieScale;
  const decodeTime = new RunCursor(timing, true);
  const composition = offsets === null ? null : new RunCursor(offsets, false);
  const seconds: number[] = [];
  for (const sample of sync) {
    const pts =
      decodeTime.decodeTimeAt(sample - 1) +
      (composition?.offsetAt(sample - 1) ?? 0);
    if (!Number.isSafeInteger(pts)) {
      throw invalid("time overflow");
    }
    const mapped = pts - edit.mediaTime;
    if (edit.mediaDuration !== null) {
      const covered = BigInt(edit.mediaDuration) * BigInt(mediaTimescale);
      if (mapped < 0 || BigInt(mapped) * BigInt(movieScale) >= covered) {
        return null;
      }
    }
    const value = mapped / mediaTimescale + emptySeconds;
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    seconds.push(value);
  }
  const unique = [...new Set(seconds)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : null;
};

/** Read video keyframe PTS from MP4 sample tables without reading media payloads. */
export async function readMp4Keyframes(
  reader: IndexReader,
): Promise<number[] | null> {
  let moov: Box | null = null;
  let pos = 0;
  while (pos < reader.size) {
    const box = await readBoxHeader(reader, pos, reader.size);
    if (box.type === "moov") {
      moov = box;
      break;
    }
    pos = box.dataEnd;
  }
  if (moov === null) {
    return null;
  }
  let movieTimescale: number | null = null;
  const traks: Box[] = [];
  for await (const child of childBoxes(reader, moov)) {
    if (child.type === "mvex") {
      return null;
    }
    if (child.type === "mvhd") {
      movieTimescale = timescaleOf(await boxPayload(reader, child), "mvhd");
    } else if (child.type === "trak") {
      traks.push(child);
    }
  }
  const chapterTrackIds = new Set<number>();
  const tracks: { box: Box; id: number | null }[] = [];
  for (const trak of traks) {
    const tkhd = await firstChild(reader, trak, "tkhd");
    let id: number | null = null;
    if (tkhd !== null) {
      const data = await boxPayload(reader, tkhd);
      const offset = data[0] === 0 ? 12 : data[0] === 1 ? 20 : null;
      if (offset === null || data.length < offset + 4) {
        throw invalid("unsupported tkhd");
      }
      id = data.readUInt32BE(offset);
    }
    tracks.push({ box: trak, id });
    const tref = await firstChild(reader, trak, "tref");
    if (tref !== null) {
      const chap = await firstChild(reader, tref, "chap");
      if (chap !== null) {
        const data = await boxPayload(reader, chap);
        if (data.length % 4 !== 0) {
          throw invalid("truncated chapter track reference");
        }
        for (let at = 0; at < data.length; at += 4) {
          chapterTrackIds.add(data.readUInt32BE(at));
        }
      }
    }
  }
  for (const { box: trak, id } of tracks) {
    if (id !== null && chapterTrackIds.has(id)) {
      continue;
    }
    if (id === null && chapterTrackIds.size > 0) {
      return null;
    }
    const result = await readTrakKeyframes(reader, trak, movieTimescale);
    if (result !== undefined) {
      return result;
    }
  }
  return null;
}
