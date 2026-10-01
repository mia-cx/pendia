import type Hls from "hls.js";
import { client, createPendiaClient } from "./api.ts";
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
  onNotice: (notice: PlayerNotice) => void;
};

const heartbeatMs = 10_000;
// Tokens live five minutes; refresh with a minute to spare.
const refreshLeadMs = 60_000;
const refreshRetryMs = 15_000;

// The last report as a tab closes has to outlive the page.
const lastWord = createPendiaClient({ keepalive: true });

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
      message: "Pendia cannot stream this Version yet.",
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

  function begin() {
    if (started !== undefined || scope === undefined) return;
    started = client.playback
      .start({ ...scope, positionSeconds: position() })
      .then(
        () => true,
        () => false,
      );
    heartbeat = setInterval(() => {
      if (!video.paused) report();
    }, heartbeatMs);
  }

  // Reports go out one at a time, so the end of a film never lands before
  // the pause that preceded it.
  function report() {
    if (started === undefined || scope === undefined) return;
    const begun = started;
    const current = {
      ...scope,
      positionSeconds: position(),
      completed: video.ended,
    };
    reports = reports
      .then(async () => {
        if (await begun) await client.playback.progress(current);
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
              xhr.open("GET", withToken(requestUrl, token), true);
          },
        });
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) onNotice(stalled);
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        void resumePlaying();
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
    void resumePlaying();
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
      });
    } catch (error) {
      if (closing === undefined) onNotice(refusal(error));
      return;
    }
    if (planned.sessionId !== null)
      scope = { sessionId: planned.sessionId, itemId };
    if (closing !== undefined) return;
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
    await attach(planned.method, planned.url, at);
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
        await reports;
        await started;
        await lastWord.playback.stop({ ...scope, ...final }).catch(() => {
          // Nothing is left to tell; the server keeps the last heartbeat.
        });
      })();
      return closing;
    },
  };
}
