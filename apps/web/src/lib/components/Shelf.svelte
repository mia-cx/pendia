<script module lang="ts">
/** The grid track columns a Shelf and its skeleton share. */
export const shelfColumns = {
  poster: "auto-cols-[clamp(7.5rem,30vw,10.5rem)] lg:auto-cols-[11.5rem]",
  landscape:
    "auto-cols-[min(80vw,19rem)] lg:auto-cols-[clamp(15rem,21vw,19rem)]",
  person: "auto-cols-[6rem] lg:auto-cols-[7rem]",
} as const;
</script>

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
  size?: "poster" | "landscape" | "person";
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

// With both top and bottom set, `my-auto` centres a paddle over the cards.
const paddle =
  "absolute top-3 bottom-6 my-auto hidden h-16 w-9 items-center justify-center rounded-full material shadow-float text-label opacity-0 transition-opacity duration-(--duration-fast) ease-smooth-out pointer-fine:flex group-hover/shelf:enabled:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none";
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
      class="row-scroll bleed mt-2 -mb-4 grid grid-flow-col gap-4 overflow-x-auto overscroll-x-contain pt-3 pb-6 ps-(--shell-start) pe-(--gutter) [scrollbar-width:none] snap-x snap-mandatory lg:gap-5 [&::-webkit-scrollbar]:hidden {shelfColumns[
        size
      ]}"
    >
      {@render children()}
    </ul>
    {#if canScroll}
      <button
        type="button"
        aria-label="Scroll left"
        disabled={!canLeft}
        onclick={() => scroll(-1)}
        class="{paddle} -left-5"
      >
        <ChevronLeftIcon class="size-6" />
      </button>
      <button
        type="button"
        aria-label="Scroll right"
        disabled={!canRight}
        onclick={() => scroll(1)}
        class="{paddle} -right-[calc(var(--gutter)-0.5rem)]"
      >
        <ChevronRightIcon class="size-6" />
      </button>
    {/if}
  </div>
</section>

<style>
  .row-scroll {
    scroll-padding-inline: var(--shell-start) var(--gutter);
  }
  .row-scroll :global(li) {
    scroll-snap-align: start;
  }
</style>
