/**
 * Reads the head of a progressive fMP4 stream until the first moof carrying
 * the video track, and reports that track's first presentation time in
 * seconds. Muxers don't start every stream's PTS at zero — mixed copy/encode
 * runs shift to the earliest DTS across tracks and B-frame copies present the
 * first decoded frame late — so the run's source offset must subtract this.
 */

type Box = { type: string; start: number; end: number };

const children = function* (
  view: DataView,
  start: number,
  end: number,
): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    if (size === 0) {
      yield { type, start: at + 8, end };
      return;
    }
    if (size === 1) {
      const large = Number(view.getBigUint64(at + 8));
      if (large < 16 || at + large > end) return;
      yield { type, start: at + 16, end: at + large };
      at += large;
      continue;
    }
    if (size < 8 || at + size > end) return;
    yield { type, start: at + 8, end: at + size };
    at += size;
  }
};

const fourcc = (view: DataView, at: number) =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

/** First presentation time per track in the head, seconds keyed by kind. */
export type StreamHead = { video: number; audio: number | null };

/**
 * The video track's first presentation time in seconds (and the audio
 * track's when present), or null while the buffer does not yet hold a
 * complete moov plus a moof carrying the video track.
 */
export function parseStreamHead(head: Uint8Array): StreamHead | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  // track_ID → {kind, timescale}
  const tracks = new Map<number, { kind: string; timescale: number }>();
  for (const box of children(view, 0, view.byteLength)) {
    if (box.type === "moov") {
      for (const trak of children(view, box.start, box.end)) {
        if (trak.type !== "trak") continue;
        let trackId = 0;
        let scale = 0;
        let kind: string | null = null;
        for (const child of children(view, trak.start, trak.end)) {
          if (child.type === "tkhd") {
            trackId = view.getUint32(
              child.start + (view.getUint8(child.start) === 1 ? 20 : 12),
            );
          }
          if (child.type !== "mdia") continue;
          for (const media of children(view, child.start, child.end)) {
            if (media.type === "hdlr") {
              const handler = fourcc(view, media.start + 8);
              if (handler === "vide") kind = "video";
              if (handler === "soun") kind = "audio";
            }
            if (media.type === "mdhd") {
              scale = view.getUint32(
                media.start + (view.getUint8(media.start) === 1 ? 28 : 20),
              );
            }
          }
        }
        if (kind !== null && trackId !== 0) {
          tracks.set(trackId, { kind, timescale: scale });
        }
      }
      continue;
    }
    if (box.type !== "moof" || tracks.size === 0) continue;
    const pts = new Map<number, number>();
    for (const traf of children(view, box.start, box.end)) {
      if (traf.type !== "traf") continue;
      let trackId = 0;
      let base = 0;
      let composition: number | null = null;
      for (const field of children(view, traf.start, traf.end)) {
        if (field.type === "tfhd") trackId = view.getUint32(field.start + 4);
        if (field.type === "tfdt") {
          base = Number(
            view.getUint8(field.start) === 1
              ? view.getBigUint64(field.start + 4)
              : BigInt(view.getUint32(field.start + 4)),
          );
        }
        if (field.type === "trun") {
          const version = view.getUint8(field.start);
          const flags =
            (view.getUint8(field.start + 1) << 16) |
            (view.getUint8(field.start + 2) << 8) |
            view.getUint8(field.start + 3);
          let at = field.start + 8; // version+flags, then sample_count
          if (flags & 0x1) at += 4; // data_offset
          if (flags & 0x4) at += 4; // first_sample_flags
          if (flags & 0x100) at += 4; // sample_duration
          if (flags & 0x200) at += 4; // sample_size
          if (flags & 0x400) at += 4; // sample_flags
          if (flags & 0x800 && at + 4 <= field.end) {
            composition =
              version === 1 ? view.getInt32(at) : view.getUint32(at);
          }
        }
      }
      const track = tracks.get(trackId);
      if (track !== undefined && track.timescale > 0) {
        pts.set(trackId, (base + (composition ?? 0)) / track.timescale);
      }
    }
    const first = [...tracks.entries()].find(
      ([, track]) => track.kind === "video",
    );
    const video = first === undefined ? null : (pts.get(first[0]) ?? null);
    if (video !== null) {
      const audio = [...tracks.entries()].find(
        ([, track]) => track.kind === "audio",
      );
      return {
        video,
        audio: audio === undefined ? null : (pts.get(audio[0]) ?? null),
      };
    }
  }
  // Incomplete boxes read as absent: a moof still arriving waits for more.
  return null;
}

/** The buffered head of a live stream plus its video's first presentation time. */
export async function readStreamHead(
  stream: ReadableStream<Uint8Array>,
): Promise<{
  head: Uint8Array;
  trackPts: StreamHead;
  reader: ReadableStreamDefaultReader<Uint8Array>;
} | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return null;
    chunks.push(value);
    length += value.length;
    const head = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      head.set(chunk, at);
      at += chunk.length;
    }
    const trackPts = parseStreamHead(head);
    if (trackPts !== null) return { head, trackPts, reader };
  }
}
