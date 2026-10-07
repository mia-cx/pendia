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

  // A wait that a close or a new fetch cancels.
  const interruptible = (ms: number, current?: AbortController) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), ms);
      const stop = () => {
        clearTimeout(timer);
        resolve();
      };
      closed.signal.addEventListener("abort", stop, { once: true });
      current?.signal.addEventListener("abort", stop, { once: true });
    });

  /** Wait for playback progress, a seek, or a second — whichever lands first. */
  const waitForProgress = (current: AbortController) =>
    new Promise<void>((resolve) => {
      const events = ["timeupdate", "seeking"];
      const done = () => {
        for (const name of events) video.removeEventListener(name, done);
        resolve();
      };
      for (const name of events)
        video.addEventListener(name, done, { once: true });
      void interruptible(1_000, current).then(done);
    });

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

  const append = async (
    chunk: Uint8Array,
    current: AbortController,
  ): Promise<boolean> => {
    if (buffer === undefined) return false;
    for (;;) {
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
      if (current.signal.aborted || closed.signal.aborted) return false;
      // The buffer is full: drop old data, or when nothing is evictable wait
      // for playback to make room.
      const end = Math.max(0, video.currentTime - trimBehindSeconds);
      if (end > 0) {
        buffer.remove(0, end);
        await nextUpdate();
        continue;
      }
      await waitForProgress(current);
    }
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
    // Drop a half-appended segment before the new run's first bytes; abort
    // works whenever the source is open, not only mid-update.
    if (buffer !== undefined && mediaSource.readyState === "open") {
      const updating = buffer.updating;
      buffer.abort();
      if (updating) await nextUpdate();
    }
    // A busy transcoder answers 503 SESSION_QUEUED with Retry-After: wait and
    // refetch the same start until a minute has passed.
    let queuedSince: number | null = null;
    let response: Response;
    for (;;) {
      try {
        response = await fetch(options.streamUrl(start), {
          signal: current.signal,
        });
      } catch {
        if (!current.signal.aborted && !closed.signal.aborted) fail();
        return;
      }
      if (response.status !== 503) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      if (queuedSince === null) queuedSince = Date.now();
      if (Date.now() - queuedSince > 60_000) {
        fail();
        return;
      }
      await interruptible(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000,
        current,
      );
      if (current.signal.aborted || closed.signal.aborted) return;
    }
    if (response.body === null || !response.ok) {
      fail();
      return;
    }
    if (buffer !== undefined) {
      // The server streams with timestamps relative to its first frame and
      // reports where that frame sits in the source.
      const offset = Number(response.headers.get("x-stream-offset"));
      try {
        buffer.timestampOffset = Number.isFinite(offset) ? offset : start;
      } catch {
        fail();
        return;
      }
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (current.signal.aborted || closed.signal.aborted) return;
        if (!(await append(value, current))) return;
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
