<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
import MaximizeIcon from "@lucide/svelte/icons/maximize";
import MinimizeIcon from "@lucide/svelte/icons/minimize";
import PauseIcon from "@lucide/svelte/icons/pause";
import PictureInPicture2Icon from "@lucide/svelte/icons/picture-in-picture-2";
import PlayIcon from "@lucide/svelte/icons/play";
import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import Volume1Icon from "@lucide/svelte/icons/volume-1";
import Volume2Icon from "@lucide/svelte/icons/volume-2";
import VolumeXIcon from "@lucide/svelte/icons/volume-x";
import { onDestroy, untrack } from "svelte";
import { afterNavigate } from "$app/navigation";
import { client } from "$lib/api.ts";
import { episodeCode, itemHref } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import PlayerSettings from "$lib/components/PlayerSettings.svelte";
import Scrubber from "$lib/components/Scrubber.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Slider from "$lib/components/ui/slider/index.ts";
import { formatPosition, pickVersion } from "$lib/playback.ts";
import { play } from "$lib/player.ts";
import { createPlayer, type PlayerState } from "$lib/player-state.ts";
import { resource } from "$lib/resource.svelte.ts";
import { cn } from "$lib/utils.ts";

let {
  id,
  versionId,
  startAt,
  player = $bindable(),
}: {
  id: string;
  /** The Version to play first; null or unknown plays the first. */
  versionId: string | null;
  /** Where to start, in seconds; null resumes. */
  startAt: number | null;
  /** The player, so the route can follow Version switches. */
  player?: ReturnType<typeof createPlayer>;
} = $props();

// The Version choice is part of the load: a link that names no Version plays
// the one the viewer's progress is on, so the session waits for both reads.
const item = resource(async () => {
  const detail = await client.items.get({ id });
  // A failed read still plays the first Version.
  const progress = await client.playback
    .getProgress({ itemId: detail.id })
    .catch(() => null);
  return { detail, progressVersionId: progress?.versionId ?? null };
});

let video = $state<HTMLVideoElement>();
let root = $state<HTMLElement>();
let barHeight = $state(0);
let playerState = $state<PlayerState>();
let fullscreen = $state(false);
let pip = $state(false);
/** The double-tap skip wash: which side and a remount key. */
let skipFlash = $state<{ side: "left" | "right"; key: number }>();
let flashKey = 0;

let lastPointerType: string | undefined;
let tapTimer: ReturnType<typeof setTimeout> | undefined;
let cameFrom: string | undefined;
let destroyed = false;

const detail = $derived(item.data?.detail);
const version = $derived(
  detail === undefined
    ? undefined
    : pickVersion(detail.versions, versionId, item.data?.progressVersionId),
);
const back = $derived(detail === undefined ? "/" : (itemHref(detail) ?? "/"));
const context = $derived(
  detail?.kind === "episode" && detail.show !== null
    ? [detail.show.title, episodeCode(detail)]
        .filter((part) => part !== null)
        .join(" · ")
    : null,
);
const shown = $derived(playerState?.controls ?? true);

$effect(() => {
  if (video === undefined || detail === undefined) return;
  if (detail.versions.length === 0) return;
  // Constructed once; URL Version changes never remount the player.
  if (player !== undefined) return;
  const initial = version;
  if (initial === undefined) return;
  const media = video;
  const detailNow = detail;
  player = untrack(() =>
    createPlayer({
      media,
      versions: detailNow.versions,
      versionId: initial.id,
      startAt,
      open: (request) =>
        play({
          video: media,
          itemId: detailNow.id,
          versionId: request.versionId,
          durationSeconds:
            detailNow.versions.find(
              (version) => version.id === request.versionId,
            )?.durationSeconds ?? null,
          startAt: request.startAt,
          streams: request.streams,
          paused: request.paused,
          onNotice: request.onNotice,
          onTracks: request.onTracks,
        }),
    }),
  );
});

$effect(() => {
  const store = player?.state;
  if (store === undefined) return;
  return store.subscribe((next) => (playerState = next));
});

// PiP events are not in TypeScript's element attributes.
$effect(() => {
  const media = video;
  if (media === undefined) return;
  const enter = () => (pip = true);
  const leavePip = () => (pip = false);
  media.addEventListener("enterpictureinpicture", enter);
  media.addEventListener("leavepictureinpicture", leavePip);
  return () => {
    media.removeEventListener("enterpictureinpicture", enter);
    media.removeEventListener("leavepictureinpicture", leavePip);
  };
});

onDestroy(() => {
  destroyed = true;
  clearTimeout(tapTimer);
  void player?.close();
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

function hide() {
  void player?.suspend();
}

function show(event: PageTransitionEvent) {
  if (event.persisted) player?.resume();
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType === "mouse") player?.activity();
}

function onStagePointerDown(event: PointerEvent) {
  lastPointerType = event.pointerType;
}

function flashSkip(side: "left" | "right") {
  flashKey += 1;
  skipFlash = { side, key: flashKey };
}

function onStageClick(event: MouseEvent) {
  if (player === undefined) return;
  // Overlay controls inside the stage act on themselves, not the stage.
  if ((event.target as HTMLElement | null)?.closest("button, a") !== null)
    return;
  if (lastPointerType === "touch") {
    // The second tap of a double tap lands while a single tap waits.
    if (tapTimer !== undefined) {
      const width = root?.clientWidth ?? 1;
      const third = event.clientX / width;
      if (third < 1 / 3 || third > 2 / 3) {
        clearTimeout(tapTimer);
        tapTimer = undefined;
        player.skip(third < 1 / 3 ? -10 : 10);
        flashSkip(third < 1 / 3 ? "left" : "right");
      }
      return;
    }
    tapTimer = setTimeout(() => {
      tapTimer = undefined;
      if (!destroyed) player?.toggleControls();
    }, 250);
    return;
  }
  player.togglePlay();
}

function onStageDoubleClick() {
  if (lastPointerType === "touch") return;
  void toggleFullscreen();
}

const canFullscreen = () =>
  document.fullscreenEnabled || video?.webkitEnterFullscreen !== undefined;

async function toggleFullscreen() {
  player?.activity();
  if (document.fullscreenElement !== null) {
    await document.exitFullscreen().catch(() => {});
    return;
  }
  if (document.fullscreenEnabled && root !== undefined) {
    await root.requestFullscreen().catch(() => {
      video?.webkitEnterFullscreen?.();
    });
    return;
  }
  video?.webkitEnterFullscreen?.();
}

async function togglePip() {
  player?.activity();
  if (video === undefined) return;
  if (document.pictureInPictureElement !== null) {
    await document.exitPictureInPicture().catch(() => {});
    return;
  }
  await video.requestPictureInPicture().catch(() => {});
}

function onKeydown(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented)
    return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("[role='menu']") !== null) return;
  player?.activity();
  const onSlider = target?.closest("[role='slider']") !== null;
  const onAction = target?.closest("button, a, [role='slider']") !== null;
  switch (event.code) {
    case "Space":
    case "KeyK":
      if (onAction) return;
      event.preventDefault();
      player?.togglePlay();
      return;
    case "ArrowLeft":
      if (onSlider) return;
      event.preventDefault();
      player?.skip(-10);
      return;
    case "ArrowRight":
      if (onSlider) return;
      event.preventDefault();
      player?.skip(10);
      return;
    case "ArrowUp":
      if (onSlider) return;
      event.preventDefault();
      player?.setVolume((playerState?.volume ?? 0) + 0.1);
      return;
    case "ArrowDown":
      if (onSlider) return;
      event.preventDefault();
      player?.setVolume((playerState?.volume ?? 1) - 0.1);
      return;
    case "KeyF":
      event.preventDefault();
      void toggleFullscreen();
      return;
    case "KeyM":
      event.preventDefault();
      player?.toggleMute();
      return;
    case "KeyC":
      event.preventDefault();
      void player?.toggleSubtitles();
      return;
  }
}

function barFocusIn(event: FocusEvent) {
  if ((event.target as HTMLElement | null)?.matches(":focus-visible"))
    player?.hold("focus", true);
}

function barFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as HTMLElement | null;
  if (
    next === null ||
    (next.closest("[data-bar]") === null &&
      next.closest("[role='menu']") === null)
  )
    player?.hold("focus", false);
}

const VolumeIcon = $derived(
  playerState === undefined || playerState.muted || playerState.volume === 0
    ? VolumeXIcon
    : playerState.volume < 0.5
      ? Volume1Icon
      : Volume2Icon,
);
</script>

<svelte:head>
  <title>{detail ? `${detail.title} · Pendia` : "Pendia"}</title>
</svelte:head>

<svelte:window
  onkeydown={onKeydown}
  onpagehide={hide}
  onpageshow={show}
  onfullscreenchange={() =>
    (fullscreen = document.fullscreenElement !== null)}
/>

<!-- svelte-ignore a11y_no_static_element_interactions: the player surface watches mouse movement -->
<div
  bind:this={root}
  class="player fixed inset-0 overflow-hidden bg-black text-white select-none dark scheme-dark"
  class:cursor-none={!shown}
  data-controls={shown ? "shown" : "hidden"}
  style:--controls-height="{barHeight}px"
  onpointermove={onPointerMove}
>
  <!-- svelte-ignore a11y_no_static_element_interactions: the stage is the tap and click surface -->
  <!-- svelte-ignore a11y_click_events_have_key_events: keyboard shortcuts live on window -->
  <div
    class="absolute inset-0"
    onclick={onStageClick}
    ondblclick={onStageDoubleClick}
    onpointerdown={onStagePointerDown}
  >
    <!-- svelte-ignore a11y_media_has_caption: captions arrive as HLS text tracks -->
    <video
      bind:this={video}
      class="absolute inset-0 size-full object-contain"
      playsinline
      preload="auto"
      aria-label={detail?.title ?? "Video"}
    ></video>

    {#if item.failure}
      <div class="absolute inset-0 grid place-items-center p-6">
        <div class="material-thick w-full max-w-sm rounded-xl px-6 py-5 shadow-float">
          <Failure failure={item.failure} />
        </div>
      </div>
    {:else if detail && detail.versions.length === 0}
      <div
        role="status"
        class="material-thick absolute inset-0 m-auto h-fit w-full max-w-sm rounded-xl px-6 py-5 text-center shadow-float"
      >
        <h2 class="text-headline">Nothing to play</h2>
        <p class="mt-1 text-subheadline text-label-secondary">
          This has no Versions yet.
        </p>
      </div>
    {:else if playerState?.notice}
      <div
        role="alert"
        class="material-thick absolute inset-0 m-auto h-fit w-full max-w-sm rounded-xl px-6 py-5 text-center shadow-float"
      >
        <h2 class="text-headline">{playerState.notice.title}</h2>
        <p class="mt-1 text-subheadline text-label-secondary">
          {playerState.notice.message}
        </p>
        {#if playerState.notice.retry}
          <Button
            variant="secondary"
            class="mt-4"
            disabled={playerState.switching}
            onclick={() => player?.retry()}>Try again</Button
          >
        {/if}
      </div>
    {/if}

    {#if playerState?.buffering && playerState.notice === undefined}
      <div
        role="status"
        class="player-buffer absolute inset-0 grid place-items-center"
      >
        <LoaderCircleIcon
          class="size-10 text-white/80 motion-safe:animate-spin"
          aria-hidden="true"
        />
        <span class="sr-only">Loading</span>
      </div>
    {/if}

    {#if skipFlash !== undefined}
      {#key skipFlash.key}
        <div
          aria-hidden="true"
          class={cn(
            "player-skip-flash pointer-events-none absolute top-1/2 flex size-20 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-full bg-white/14",
            skipFlash.side === "left" ? "left-[16%]" : "right-[16%]",
          )}
          onanimationend={() => (skipFlash = undefined)}
        >
          {#if skipFlash.side === "left"}
            <RotateCcwIcon class="size-6" aria-hidden="true" />
          {:else}
            <RotateCwIcon class="size-6" aria-hidden="true" />
          {/if}
          <span class="text-caption-2 font-semibold">10 seconds</span>
        </div>
      {/key}
    {/if}
  </div>

  <div
    data-bar
    inert={!shown}
    class={cn(
      "absolute inset-x-0 top-0 flex items-center gap-3 bg-linear-to-b from-black/60 to-transparent pb-10 transition-opacity ease-smooth-out",
      shown
        ? "opacity-100 duration-(--duration-fast)"
        : "pointer-events-none opacity-0 duration-(--duration-medium)",
    )}
    style="padding-top: max(0.75rem, env(safe-area-inset-top)); padding-left: max(var(--gutter), env(safe-area-inset-left)); padding-right: max(var(--gutter), env(safe-area-inset-right));"
    onfocusin={barFocusIn}
    onfocusout={barFocusOut}
  >
    <Button
      variant="glass"
      size="icon"
      href={back}
      onclick={leave}
      aria-label="Back"
      class="shrink-0"
    >
      <ChevronLeftIcon aria-hidden="true" />
    </Button>
    {#if detail}
      <div class="min-w-0">
        <h1 class="truncate text-headline">{detail.title}</h1>
        {#if context}
          <p class="truncate text-footnote text-white/70">{context}</p>
        {/if}
      </div>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions: hover over the bar holds the controls up -->
  <div
    data-bar
    inert={!shown}
    class={cn(
      "absolute inset-x-0 bottom-0 bg-linear-to-t from-black/75 via-black/35 to-transparent pt-24 transition-opacity ease-smooth-out",
      shown
        ? "opacity-100 duration-(--duration-fast)"
        : "pointer-events-none opacity-0 duration-(--duration-medium)",
    )}
    style="padding-left: max(var(--gutter), env(safe-area-inset-left)); padding-right: max(var(--gutter), env(safe-area-inset-right)); padding-bottom: max(1rem, env(safe-area-inset-bottom));"
    onpointerenter={(event) =>
      event.pointerType === "mouse" && player?.hold("pointer", true)}
    onpointerleave={(event) =>
      event.pointerType === "mouse" && player?.hold("pointer", false)}
    onfocusin={barFocusIn}
    onfocusout={barFocusOut}
  >
    <div bind:clientHeight={barHeight} class="flex flex-col gap-2">
      <div class="flex items-center gap-3">
        <span
          class="min-w-14 text-right text-footnote tabular-nums text-white/80"
          >{formatPosition(playerState?.position ?? 0)}</span
        >
        <Scrubber
          position={playerState?.position ?? 0}
          duration={playerState?.duration ?? 0}
          buffered={playerState?.buffered ?? []}
          onseek={(seconds) => player?.seek(seconds)}
        />
        <span class="min-w-14 text-footnote tabular-nums text-white/80"
          >−{formatPosition(
            Math.max(0, (playerState?.duration ?? 0) - (playerState?.position ?? 0)),
          )}</span
        >
      </div>
      <div class="grid grid-cols-[1fr_auto_1fr] items-center">
        <div class="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={playerState?.muted ? "Unmute" : "Mute"}
            class="text-white hover:bg-white/12"
            onclick={() => player?.toggleMute()}
          >
            <VolumeIcon aria-hidden="true" />
          </Button>
          <div class="w-24 pointer-coarse:hidden">
            {#if playerState}
              <Slider.Root
                variant="media"
                type="single"
                value={playerState.muted ? 0 : playerState.volume * 100}
                onValueChange={(next) => player?.setVolume(next / 100)}
                min={0}
                max={100}
                step={1}
                aria-label="Volume"
                valueText={`${Math.round(playerState.volume * 100)}%`}
              />
            {/if}
          </div>
        </div>
        <div
          class="flex items-center justify-center gap-2 max-sm:pointer-events-none max-sm:fixed max-sm:inset-0"
        >
          <Button
            variant="ghost"
            aria-label="Back 10 seconds"
            class="relative size-11 text-white hover:bg-white/12 max-sm:pointer-events-auto max-sm:size-12"
            onclick={() => player?.skip(-10)}
          >
            <RotateCcwIcon class="size-6" aria-hidden="true" />
            <span
              aria-hidden="true"
              class="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pt-0.5 text-caption-2 font-semibold"
              >10</span
            >
          </Button>
          <Button
            variant="ghost"
            aria-label={playerState?.playing ? "Pause" : "Play"}
            class="size-12 text-white hover:bg-white/12 max-sm:pointer-events-auto max-sm:size-16"
            onclick={() => player?.togglePlay()}
          >
            {#if playerState?.playing}
              <PauseIcon class="size-7" fill="currentColor" aria-hidden="true" />
            {:else}
              <PlayIcon class="size-7" fill="currentColor" aria-hidden="true" />
            {/if}
          </Button>
          <Button
            variant="ghost"
            aria-label="Forward 10 seconds"
            class="relative size-11 text-white hover:bg-white/12 max-sm:pointer-events-auto max-sm:size-12"
            onclick={() => player?.skip(10)}
          >
            <RotateCwIcon class="size-6" aria-hidden="true" />
            <span
              aria-hidden="true"
              class="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pt-0.5 text-caption-2 font-semibold"
              >10</span
            >
          </Button>
        </div>
        <div class="flex items-center justify-end gap-1">
          {#if typeof document !== "undefined" && document.pictureInPictureEnabled}
            <Button
              variant="ghost"
              size="icon"
              aria-label={pip ? "Exit Picture in Picture" : "Picture in Picture"}
              class="text-white hover:bg-white/12"
              onclick={() => void togglePip()}
            >
              <PictureInPicture2Icon aria-hidden="true" />
            </Button>
          {/if}
          {#if player !== undefined && playerState !== undefined && detail !== undefined}
            <PlayerSettings {player} state={playerState} versions={detail.versions} portal={root} />
          {/if}
          {#if canFullscreen()}
            <Button
              variant="ghost"
              size="icon"
              aria-label={fullscreen ? "Exit Full Screen" : "Full Screen"}
              class="text-white hover:bg-white/12"
              onclick={() => void toggleFullscreen()}
            >
              {#if fullscreen}
                <MinimizeIcon aria-hidden="true" />
              {:else}
                <MaximizeIcon aria-hidden="true" />
              {/if}
            </Button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  /* Short waits never flash the spinner. */
  .player-buffer {
    pointer-events: none;
    animation: player-fade-in var(--duration-fast) ease-out 400ms backwards;
  }

  .player-skip-flash {
    animation: player-skip-flash 600ms ease-out forwards;
  }

  @keyframes player-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes player-skip-flash {
    from {
      opacity: 1;
      transform: translateY(-50%) scale(1);
    }
    to {
      opacity: 0;
      transform: translateY(-50%) scale(1.12);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .player-skip-flash {
      animation-name: player-skip-flash-still;
    }
  }

  @keyframes player-skip-flash-still {
    from {
      opacity: 1;
      transform: translateY(-50%);
    }
    to {
      opacity: 0;
      transform: translateY(-50%);
    }
  }

  .player :global(video::cue) {
    background-color: oklch(0% 0 0deg / 72%);
    color: white;
    font-family: var(--font-sans);
    font-weight: 500;
    font-size: clamp(1rem, 3.6vh, 2.25rem);
    line-height: 1.3;
  }

  .player[data-controls="shown"]
    :global(video::-webkit-media-text-track-container) {
    transform: translateY(calc(-1 * var(--controls-height, 0px)));
    transition: transform var(--duration-fast) ease-out;
  }
</style>
