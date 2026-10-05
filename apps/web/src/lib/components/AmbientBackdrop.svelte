<script lang="ts">
import { artworkUrl } from "$lib/browse.ts";

const {
  artworkId,
  hue,
}: {
  /** The artwork whose blur washes the page, or null for the hue fallback. */
  artworkId: string | null;
  /** The fallback hue from the hero's title when there is no art. */
  hue: number;
} = $props();

let loaded = $state(false);
</script>

<!-- A page-wide wash of the hero's art, so the section below it borrows its colour. -->
<div
  class="backdrop pointer-events-none fixed inset-0 -z-10 overflow-hidden"
  aria-hidden="true"
>
  {#if artworkId}
    <img
      src={artworkUrl(artworkId, 480)}
      alt=""
      loading="lazy"
      decoding="async"
      onload={() => (loaded = true)}
      class="absolute inset-0 size-full scale-125 object-cover saturate-150 blur-3xl transition-opacity duration-(--duration-slow) {loaded
        ? 'opacity-100'
        : 'opacity-0'}"
    />
  {:else}
    <div
      class="absolute inset-0 artwork-fallback"
      style:--fallback-hue={hue}
    ></div>
  {/if}
  <div
    class="absolute inset-0 bg-background/80 dark:bg-background/60"
  ></div>
</div>

<style>
  @media (prefers-reduced-transparency: reduce) {
    .backdrop > * {
      display: none;
    }
    .backdrop {
      background: var(--background);
    }
  }
</style>
