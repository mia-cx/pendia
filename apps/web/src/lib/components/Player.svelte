<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { afterNavigate, goto } from "$app/navigation";
import { client } from "$lib/api.ts";
import { episodeCode, itemHref } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import { audioNames, subtitleNames } from "$lib/playback.ts";
import {
  type PlannedTracks,
  type PlayerNotice,
  play,
  type StreamChoice,
} from "$lib/player.ts";
import { resource } from "$lib/resource.svelte.ts";

const {
  id,
  versionId,
  startAt,
}: {
  id: string;
  /** The Version to play; null or unknown plays the first. */
  versionId: string | null;
  /** Where to start, in seconds; null resumes. */
  startAt: number | null;
} = $props();

const item = resource(() => client.items.get({ id }));

let video = $state<HTMLVideoElement>();
let notice = $state<PlayerNotice>();
// True while a restart or Version switch waits for the old session to stop.
let busy = $state(false);
let tracks = $state<PlannedTracks>();
// What the viewer picked from the menus; a retry keeps it.
let streams: StreamChoice = {};
let session: ReturnType<typeof play> | undefined;
let cameFrom: string | undefined;
let destroyed = false;
let hiddenAt: number | null = null;

const detail = $derived(item.data);
const version = $derived(
  detail?.versions.find((candidate) => candidate.id === versionId) ??
    detail?.versions[0],
);
const back = $derived(detail === undefined ? "/" : (itemHref(detail) ?? "/"));
const context = $derived(
  detail?.kind === "episode" && detail.show !== null
    ? [detail.show.title, episodeCode(detail)]
        .filter((part) => part !== null)
        .join(" · ")
    : null,
);

function start(at: number | null) {
  if (video === undefined || detail === undefined || version === undefined)
    return;
  notice = undefined;
  session = play({
    video,
    itemId: detail.id,
    versionId: version.id,
    durationSeconds: version.durationSeconds,
    startAt: at,
    streams,
    onNotice: (next) => (notice = next),
    onTracks: (next) => (tracks = next),
  });
}

$effect(() => {
  if (video !== undefined && detail !== undefined && version !== undefined)
    untrack(() => start(startAt));
});

onDestroy(() => {
  destroyed = true;
  void session?.close();
});

afterNavigate(({ from }) => {
  // from.url is null when the player is the page the app hydrated on.
  cameFrom = from?.url?.pathname;
});

// Back returns through history when the detail page opened the player, so
// the browser's own Back does not land on the player again.
function leave(event: MouseEvent) {
  if (cameFrom !== back) return;
  event.preventDefault();
  history.back();
}

// A retry or a new audio or subtitle Stream starts a new session here.
async function restart() {
  if (busy) return;
  busy = true;
  const at = video?.currentTime ?? 0;
  await session?.close();
  busy = false;
  if (!destroyed) start(at);
}

function chooseAudio(value: string) {
  streams = { ...streams, audioStreamIndex: Number(value) };
  void restart();
}

function chooseSubtitles(value: string) {
  streams = {
    ...streams,
    subtitleStreamIndex: value === "off" ? null : Number(value),
  };
  void restart();
}

// Stop first, so the next session resumes from the position stop recorded.
async function switchVersion(next: string) {
  busy = true;
  await session?.close();
  if (!destroyed)
    await goto(`/play/${id}?version=${next}`, { replaceState: true });
}

// The back/forward cache keeps this page alive with its session stopped, so
// a restored page starts a new session where the old one left off.
function hide() {
  hiddenAt = video?.currentTime ?? null;
  void session?.close();
}

function show(event: PageTransitionEvent) {
  if (event.persisted) start(hiddenAt);
}
</script>

<svelte:head>
  <title>{detail ? `${detail.title} · Pendia` : "Pendia"}</title>
</svelte:head>

<svelte:window onpagehide={hide} onpageshow={show} />

<div class="player">
  <div class="bar">
    <a class="back" href={back} onclick={leave}
      ><span aria-hidden="true">‹</span> Back</a
    >
    {#if detail}
      <div class="title">
        <h1>{detail.title}</h1>
        {#if context}
          <p>{context}</p>
        {/if}
      </div>
      <div class="menus">
        {#if version && detail.versions.length > 1}
          <label class="menu">
            <span>Version</span>
            <select
              value={version.id}
              disabled={busy}
              onchange={(event) => switchVersion(event.currentTarget.value)}
            >
              {#each detail.versions as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if tracks && tracks.audioStreams.length > 1}
          {@const names = audioNames(tracks.audioStreams)}
          <label class="menu">
            <span>Audio</span>
            <select
              value={String(tracks.audioStreamIndex)}
              disabled={busy}
              onchange={(event) => chooseAudio(event.currentTarget.value)}
            >
              {#each tracks.audioStreams as stream, position (stream.index)}
                <option value={String(stream.index)}>{names[position]}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if tracks && tracks.subtitleStreams.length > 0}
          {@const names = subtitleNames(tracks.subtitleStreams)}
          <label class="menu">
            <span>Subtitles</span>
            <select
              value={tracks.subtitleStreamIndex === null
                ? "off"
                : String(tracks.subtitleStreamIndex)}
              disabled={busy}
              onchange={(event) => chooseSubtitles(event.currentTarget.value)}
            >
              <option value="off">Off</option>
              {#each tracks.subtitleStreams as stream, position (stream.index)}
                <option value={String(stream.index)}>{names[position]}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>
    {/if}
  </div>

  <div class="stage">
    <!-- svelte-ignore a11y_media_has_caption: captions arrive as HLS text tracks -->
    <video
      bind:this={video}
      controls
      playsinline
      preload="auto"
      aria-label={detail?.title ?? "Video"}
    ></video>
    {#if item.failure}
      <div class="notice"><Failure failure={item.failure} /></div>
    {:else if detail && !version}
      <div class="notice" role="status">
        <h2>Nothing to play</h2>
        <p>This has no Versions yet.</p>
      </div>
    {:else if notice}
      <div class="notice" role="alert">
        <h2>{notice.title}</h2>
        <p>{notice.message}</p>
        {#if notice.retry}
          <button type="button" disabled={busy} onclick={restart}
            >Try again</button
          >
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* The stage is dark in both colour schemes, so the picture sets the light. */
  .player {
    --canvas: oklch(0% 0 0deg);
    --ink: oklch(94% 0.012 250deg);
    --muted: oklch(72% 0.025 250deg);
    --signal: oklch(66% 0.17 255deg);
    --danger: oklch(70% 0.16 25deg);
    --line: color-mix(in oklch, var(--ink) 16%, transparent);

    position: fixed;
    inset: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--canvas);
    color: var(--ink);
    color-scheme: dark;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
    padding: 8px var(--gutter);
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    color: var(--ink);
    font-weight: 600;
    text-decoration: none;
  }

  .back span {
    font-size: 24px;
    line-height: 1;
  }

  .back:hover {
    color: var(--signal);
  }

  .title {
    flex: 1 1 0;
    min-width: 0;
  }

  h1 {
    margin: 0;
    overflow: hidden;
    font-size: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title p {
    margin: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menus {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
  }

  .menu {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 400;
  }

  .menu span {
    color: var(--muted);
  }

  select {
    max-width: 30vw;
    min-height: 36px;
  }

  .stage {
    position: relative;
    display: grid;
    min-height: 0;
  }

  video {
    width: 100%;
    height: 100%;
    background: var(--canvas);
    object-fit: contain;
  }

  .notice {
    position: absolute;
    inset: 0;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 12px;
    padding: 24px;
    background: color-mix(in oklch, var(--canvas) 80%, transparent);
    text-align: center;
  }

  .notice h2 {
    margin: 0;
  }

  .notice p {
    max-width: 44ch;
    margin: 0;
    color: var(--muted);
  }

  @media (max-width: 640px) {
    .title {
      flex-basis: calc(100% - 96px);
    }

    .menus {
      flex-basis: 100%;
    }

    .menu {
      flex: 1 1 100%;
    }

    .menu span {
      min-width: 9ch;
    }

    select {
      flex: 1;
      min-width: 0;
      max-width: none;
    }
  }
</style>
