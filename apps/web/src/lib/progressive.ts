/** Options for attaching a progressive fMP4 stream to a video element through MSE. */
export type ProgressiveOptions = {
  /** The stream URL for a run starting at the given source second. */
  streamUrl: (start: number) => string;
  /** The stream's MIME, from the plan's output codecs. */
  mime: string;
  /** The Version's length; reported durations never pass it. */
  durationSeconds: number | null;
  /** Source second playback starts at. */
  startAt: number;
  onError: () => void;
};

// Stop reading while this much is buffered ahead of the position; resume under the low mark.
const highWaterSeconds = 90;
const lowWaterSeconds = 60;
// A seek landing this far past the buffered end still lets the current fetch reach it.
const reachSeconds = 5;
// On a full buffer drop everything older than this far behind the position.
const trimBehindSeconds = 10;

/**
 * Feeds a progressive fMP4 stream into a SourceBuffer in segments mode.
 * Position seeks restart the fetch at the target; the server's ffmpeg is
 * killed when the old request's connection closes.
 */
export function attachProgressive(
  video: HTMLVideoElement,
  options: ProgressiveOptions,
): { close(): void } {
  const Source = globalThis.ManagedMediaSource ?? globalThis.MediaSource;
  const mediaSource = new Source();
  // ManagedMediaSource (iOS Safari) disables AirPlay; keep remote playback on plain MediaSource.
  if (Source === globalThis.ManagedMediaSource) {
    video.disableRemotePlayback = true;
  }
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;

  const closed = new AbortController();
  let buffer: SourceBuffer | undefined;
  let fetching: AbortController | null = null;
  let failed = false;

  const bufferedEnd = () => {
    if (buffer === undefined || buffer.buffered.length === 0) return 0;
    return buffer.buffered.end(buffer.buffered.length - 1);
  };

  const bufferedAhead = () => bufferedEnd() - video.currentTime;

  const nextUpdate = () =>
    new Promise<void>((resolve) =>
      buffer?.addEventListener("updateend", () => resolve(), { once: true }),
    );

  const waitWhileFull = async () => {
    while (bufferedAhead() > lowWaterSeconds && !closed.signal.aborted) {
      await new Promise<void>((resolve) =>
        video.addEventListener("timeupdate", () => resolve(), {
          once: true,
          signal: closed.signal,
        }),
      ).catch(() => {});
    }
  };

  const append = async (chunk: Uint8Array): Promise<boolean> => {
    if (buffer === undefined) return false;
    try {
      buffer.appendBuffer(chunk as BufferSource);
      await nextUpdate();
      return true;
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        error.name !== "QuotaExceededError"
      )
        throw error;
    }
    // The buffer is full: drop old data and retry, then wait for playback.
    const end = Math.max(0, video.currentTime - trimBehindSeconds);
    if (end > 0) {
      buffer.remove(0, end);
      await nextUpdate();
      try {
        buffer.appendBuffer(chunk as BufferSource);
        await nextUpdate();
        return true;
      } catch (error) {
        if (
          !(error instanceof DOMException) ||
          error.name !== "QuotaExceededError"
        )
          throw error;
      }
    }
    await waitWhileFull();
    return append(chunk);
  };

  const fail = () => {
    if (!failed) {
      failed = true;
      options.onError();
    }
  };

  async function streamFrom(start: number) {
    fetching?.abort();
    fetching = new AbortController();
    const current = fetching;
    // Drop a half-appended segment before the new run's first bytes.
    if (buffer?.updating) {
      buffer.abort();
      await nextUpdate();
    }
    let response: Response;
    try {
      response = await fetch(options.streamUrl(start), {
        signal: current.signal,
      });
    } catch {
      if (!current.signal.aborted && !closed.signal.aborted) fail();
      return;
    }
    if (response.body === null || !response.ok) {
      fail();
      return;
    }
    if (buffer !== undefined) {
      // The server streams with timestamps relative to its first frame and
      // reports where that frame sits in the source.
      const offset = Number(response.headers.get("x-stream-offset"));
      buffer.timestampOffset = Number.isFinite(offset) ? offset : start;
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (current.signal.aborted || closed.signal.aborted) return;
        if (!(await append(value))) return;
        if (bufferedAhead() > highWaterSeconds) await waitWhileFull();
      }
    } catch {
      if (!current.signal.aborted && !closed.signal.aborted) fail();
      return;
    }
    // The stream ended: natural end near the duration is fine, else an error.
    const end =
      options.durationSeconds !== null &&
      bufferedEnd() >= options.durationSeconds - 1;
    if (end) {
      try {
        mediaSource.endOfStream();
      } catch {
        // The element is detached or already ended.
      }
    } else if (!closed.signal.aborted) {
      fail();
    }
  }

  video.addEventListener(
    "seeking",
    () => {
      if (buffer === undefined) return;
      const target = video.currentTime;
      const ranges = buffer.buffered;
      for (let i = 0; i < ranges.length; i++) {
        const start = ranges.start(i);
        const end = ranges.end(i);
        if (target >= start && target <= end) return;
        if (target > end && target - end <= reachSeconds && fetching !== null)
          return;
      }
      void streamFrom(target);
    },
    { signal: closed.signal },
  );

  mediaSource.addEventListener(
    "sourceopen",
    () => {
      if (options.durationSeconds !== null) {
        try {
          mediaSource.duration = options.durationSeconds;
        } catch {
          // An open-ended stream still plays; duration comes from the data.
        }
      }
      buffer = mediaSource.addSourceBuffer(options.mime);
      buffer.mode = "segments";
      video.currentTime = options.startAt;
      void streamFrom(options.startAt);
    },
    { signal: closed.signal },
  );

  return {
    /** Aborts the fetch and detaches the media source. */
    close() {
      closed.abort();
      fetching?.abort();
      fetching = null;
      URL.revokeObjectURL(objectUrl);
    },
  };
}
