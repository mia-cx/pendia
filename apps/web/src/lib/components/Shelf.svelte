<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { onMount, type Snippet } from "svelte";

const {
  title,
  id,
  size = "poster",
  href = undefined,
  children,
}: {
  title: string;
  id: string;
  size?: "poster" | "landscape";
  href?: string;
  children: Snippet;
} = $props();

let track = $state<HTMLUListElement | undefined>(undefined);
let canScroll = $state(false);
let canLeft = $state(false);
let canRight = $state(false);

function measure() {
  if (!track) return;
  canScroll = track.scrollWidth > track.clientWidth + 1;
  canLeft = track.scrollLeft > 1;
  canRight = track.scrollLeft < track.scrollWidth - track.clientWidth - 1;
}

onMount(() => {
  measure();
  const observer = new ResizeObserver(measure);
  if (track) observer.observe(track);
  return () => observer.disconnect();
});

function scroll(direction: 1 | -1) {
  if (!track) return;
  track.scrollBy({
    left: direction * track.clientWidth * 0.85,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}
</script>

<section aria-labelledby={id}>
  <div class="flex h-8 items-center justify-between">
    <h2 {id} class="text-title-2">
      {#if href}
        <a
          {href}
          class="group/title inline-flex items-center gap-0.5 text-label no-underline"
        >
          {title}
          <ChevronRightIcon
            class="size-5 text-label-secondary transition-opacity duration-(--duration-quick) group-hover/title:opacity-60"
          />
        </a>
      {:else}
        {title}
      {/if}
    </h2>
  </div>
  <div class="relative group/shelf">
    <ul
      bind:this={track}
      onscroll={measure}
      class="row-scroll mt-2 -mb-4 grid grid-flow-col gap-4 overflow-x-auto overscroll-x-contain pt-3 pb-6 [scrollbar-width:none] snap-x snap-mandatory lg:gap-5 [&::-webkit-scrollbar]:hidden {size ===
      'landscape'
        ? 'auto-cols-[min(80vw,19rem)] lg:auto-cols-[clamp(15rem,21vw,19rem)]'
        : 'auto-cols-[clamp(7.5rem,30vw,10.5rem)] lg:auto-cols-[11.5rem]'}"
    >
      {@render children()}
    </ul>
    {#if canScroll}
      <button
        type="button"
        aria-label="Scroll left"
        disabled={!canLeft}
        onclick={() => scroll(-1)}
        class="paddle top-3 bottom-6 -left-5 hidden pointer-fine:flex"
      >
        <ChevronLeftIcon class="size-6" />
      </button>
      <button
        type="button"
        aria-label="Scroll right"
        disabled={!canRight}
        onclick={() => scroll(1)}
        class="paddle top-3 bottom-6 -right-[calc(var(--gutter)-0.5rem)] hidden pointer-fine:flex"
      >
        <ChevronRightIcon class="size-6" />
      </button>
    {/if}
  </div>
</section>

<style>
  .row-scroll {
    margin-inline: calc(-1 * var(--shell-start)) calc(-1 * var(--gutter));
    padding-inline: var(--shell-start) var(--gutter);
    scroll-padding-inline: var(--shell-start) var(--gutter);
  }
  .row-scroll :global(li) {
    scroll-snap-align: start;
  }
  .paddle {
    position: absolute;
    /* With both top and bottom set, auto margins centre it over the cards. */
    margin-block: auto;
    width: 2.25rem;
    height: 4rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: var(--label);
    background-color: var(--material);
    -webkit-backdrop-filter: blur(var(--material-blur)) saturate(180%);
    backdrop-filter: blur(var(--material-blur)) saturate(180%);
    box-shadow:
      inset 0 0 0 0.5px var(--material-edge),
      var(--elevation-float);
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-smooth-out);
  }
  .group\/shelf:hover .paddle:not(:disabled),
  .paddle:focus-visible {
    opacity: 1;
  }
  .paddle:disabled {
    opacity: 0;
    pointer-events: none;
  }
</style>
