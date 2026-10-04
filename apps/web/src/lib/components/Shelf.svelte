<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { onMount, type Snippet } from "svelte";
import { Button } from "$lib/components/ui/button/index.ts";

const {
  title,
  id,
  children,
}: { title: string; id: string; children: Snippet } = $props();

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
    <h2 {id} class="text-title-2">{title}</h2>
    {#if canScroll}
      <div class="hidden gap-1 pointer-fine:flex">
        <Button
          variant="glass"
          size="icon-sm"
          aria-label="Scroll left"
          disabled={!canLeft}
          onclick={() => scroll(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="glass"
          size="icon-sm"
          aria-label="Scroll right"
          disabled={!canRight}
          onclick={() => scroll(1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    {/if}
  </div>
  <ul
    bind:this={track}
    onscroll={measure}
    class="row-scroll mt-2 -mb-4 grid auto-cols-[clamp(7.5rem,28vw,10.5rem)] grid-flow-col gap-4 overflow-x-auto overscroll-x-contain pt-3 pb-6 [scrollbar-width:none] snap-x snap-mandatory lg:auto-cols-[11rem] lg:gap-5 [&::-webkit-scrollbar]:hidden"
  >
    {@render children()}
  </ul>
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
</style>
