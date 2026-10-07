import type Hls from "hls.js";
import { client, createThaliaClient } from "./api.ts";
import { readFailure } from "./errors.ts";
import { browserProfile, withToken } from "./playback.ts";

/** A message the player draws over the video. */
export type PlayerNotice = { title: string; message: string; retry: boolean };

/** One playback attempt: an Item's Version on a video element. */
export type PlaybackOptions = {
  video: HTMLVideoElement;
  itemId: string;
  versionId: string;
  /** The Version's probed length; reported positions never pass it. */
  durationSeconds: number | null;
  /** Where to start, in seconds; null resumes where the viewer left off. */
  startAt: number | null;
  /** Starts loaded but paused, so a paused viewer stays paused across a switch. */
  paused?: boolean;
  /** The audio and subtitle Streams to play; the server picks what is absent. */
  streams: StreamChoice;
  onNotice: (notice: PlayerNotice) => void;
  /** Receives the Version's Streams and the ones the session plays. */
  onTracks: (tracks: PlannedTracks) => void;
};

/** Source Stream indexes to play; a null subtitle turns subtitles off. */
export type StreamChoice = {
  audioStreamIndex?: number;
  subtitleStreamIndex?: number | null;
};

/** What a plan says about Streams: every audio and subtitle Stream, and the ones it plays. */
export type PlannedTracks = Pick<
  Awaited<ReturnType<typeof client.playback.plan>>,
  | "audioStreams"
  | "subtitleStreams"
  | "audioStreamIndex"
  | "subtitleStreamIndex"
>;

const heartbeatMs = 10_000;
// Tokens live five minutes; refresh with a minute to spare.
const refreshLeadMs = 60_000;
const refreshRetryMs = 15_000;
// How long close waits for pending reports before it sends stop.
const closeWaitMs = 3_000;

// The last report as a tab closes has to outlive the page.
const lastWord = createThaliaClient({ keepalive: true });

const cannotPlay = "Cannot play this Version";
const stalled: PlayerNotice = {
  title: "Playback stopped",
  message: "The video stopped loading.",
  retry: true,
};

function refusal(error: unknown): PlayerNotice {
  const failure = readFailure(error);
  if (failure.code === "UNREACHABLE")
    return {
      title: "Server unreachable",
      message: failure.message,
      retry: true,
    };
  if (failure.code === "UNKNOWN")
    return { title: "Playback stopped", message: failure.message, retry: true };
  if (failure.code === "CONFLICT")
    return {
      title: cannotPlay,
      message: "Thalia cannot stream this Version yet.",
      retry: false,
    };
  return { title: cannotPlay, message: failure.message, retry: false };
}

const tokenOf = (url: string) =>
  new URL(url, location.href).searchParams.get("token");

/**
 * Plans a session, plays it on the video element and reports progress:
 * start on the first frame, a heartbeat while playing, and stop on close.
 */
export function play(options: PlaybackOptions) {
  const { video, itemId, versionId, onNotice } = options;
  const events = new AbortController();
  let closing: Promise<void> | undefined;
  let scope: { sessionId: string; itemId: string } | undefined;
  let hls: Hls | undefined;
  let token: string | null = null;
  let started: Promise<boolean> | undefined;
  let reports = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const position = () =>
    options.durationSeconds === null
      ? video.currentTime
      : Math.min(video.currentTime, options.durationSeconds);

  const on = <K extends keyof HTMLMediaElementEventMap>(
    type: K,
    listener: () => void,
    once = false,
  ) => video.addEventListener(type, listener, { once, signal: events.signal });

  const resumePlaying = () =>
    video.play().catch(() => {
      // The browser refused autoplay; the controls stay ready for a click.
    });

  function seekOnLoad(at: number) {
    if (at > 0) on("loadedmetadata", () => (video.currentTime = at), true);
  }

  function reportStart(current: { sessionId: string; itemId: string }) {
    started = client.playback
      .start({ ...current, positionSeconds: position() })
      .then(
        () => true,
        () => false,
      );
    return started;
  }

  function begin() {
    if (started !== undefined || scope === undefined) return;
    void reportStart(scope);
    heartbeat = setInterval(() => {
      if (!video.paused) report();
    }, heartbeatMs);
  }

  // Reports go out one at a time, so the end of a film never lands before
  // the pause that preceded it.
  function report() {
    if (started === undefined || scope === undefined) return;
    const session = scope;
    const current = {
      ...session,
      positionSeconds: position(),
      completed: video.ended,
    };
    reports = reports
      .then(async () => {
        // A failed start is retried here, or the server drops every report.
        if ((await started) || (await reportStart(session)))
          await client.playback.progress(current);
      })
      .catch(() => {
        // A missed heartbeat is replaced by the next one.
      });
  }

  function schedule(expiresAt: string | null) {
    if (expiresAt === null) return;
    const delay = Date.parse(expiresAt) - Date.now() - refreshLeadMs;
    refreshTimer = setTimeout(refresh, Math.max(0, delay));
  }

  async function refresh() {
    if (scope === undefined) return;
    try {
      const next = await client.playback.refresh(scope);
      if (closing !== undefined || next.url === null) return;
      token = tokenOf(next.url);
      // hls.js picks the new token up per request; a video element needs
      // the new URL, at the same position.
      if (hls === undefined) {
        const playing = !video.paused;
        seekOnLoad(video.currentTime);
        video.src = next.url;
        if (playing) void resumePlaying();
      }
      schedule(next.expiresAt);
    } catch {
      if (closing === undefined)
        refreshTimer = setTimeout(refresh, refreshRetryMs);
    }
  }

  async function attach(method: string, url: string, at: number) {
    if (method !== "direct-play") {
      const { default: HlsPlayer } = await import("hls.js");
      if (closing !== undefined) return;
      if (HlsPlayer.isSupported()) {
        hls = new HlsPlayer({
          startPosition: at,
          xhrSetup: (xhr, requestUrl) => {
            if (token !== null)
              xhr.open(
                "GET",
                withToken(requestUrl, token, location.href),
                true,
              );
          },
        });
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          console.error("hls.js stopped:", data.details, data.error);
          onNotice(stalled);
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        if (!options.paused) void resumePlaying();
        return;
      }
      if (video.canPlayType("application/vnd.apple.mpegurl") === "") {
        onNotice({
          title: cannotPlay,
          message: "This browser cannot play HLS.",
          retry: false,
        });
        return;
      }
    }
    seekOnLoad(at);
    video.src = url;
    if (!options.paused) void resumePlaying();
  }

  async function open() {
    let at: number;
    let planned: Awaited<ReturnType<typeof client.playback.plan>>;
    try {
      at =
        options.startAt ??
        (await client.playback.resume({ itemId, versionId })).positionSeconds;
      planned = await client.playback.plan({
        itemId,
        versionId,
        profile: browserProfile(),
        ...options.streams,
      });
    } catch (error) {
      if (closing === undefined) onNotice(refusal(error));
      return;
    }
    if (planned.sessionId !== null)
      scope = { sessionId: planned.sessionId, itemId };
    if (closing !== undefined) return;
    options.onTracks(planned);
    if (planned.url === null) {
      onNotice({
        title: cannotPlay,
        message: "It needs transcoding, which this server does not do yet.",
        retry: false,
      });
      return;
    }
    token = tokenOf(planned.url);
    on("playing", begin);
    on("pause", () => {
      if (!video.ended) report();
    });
    on("ended", report);
    on("error", () => {
      if (hls === undefined) onNotice(stalled);
    });
    schedule(planned.expiresAt);
    try {
      await attach(planned.method, planned.url, at);
    } catch (error) {
      // hls.js is a lazy chunk; losing the server can fail its import.
      if (closing === undefined) onNotice(refusal(error));
    }
  }

  const opened = open();

  return {
    /** Stops the session with its last position and releases the video element. Safe to call twice. */
    close(): Promise<void> {
      closing ??= (async () => {
        const final = { positionSeconds: position(), completed: video.ended };
        events.abort();
        clearInterval(heartbeat);
        clearTimeout(refreshTimer);
        hls?.destroy();
        video.removeAttribute("src");
        video.load();
        await opened;
        if (scope === undefined) return;
        const session = scope;
        // Stop saves the position only for a started session. A hung report
        // must not keep stop from going out.
        const settled = reports.then(async () => {
          if (started !== undefined && !(await started))
            await reportStart(session);
        });
        await Promise.race([
          settled,
          new Promise((resolve) => setTimeout(resolve, closeWaitMs)),
        ]);
        await lastWord.playback.stop({ ...scope, ...final }).catch(() => {
          // Nothing is left to tell; the server keeps the last heartbeat.
        });
      })();
      return closing;
    },
  };
}
