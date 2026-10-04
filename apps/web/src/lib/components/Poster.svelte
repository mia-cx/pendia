<script lang="ts">
import ClapperboardIcon from "@lucide/svelte/icons/clapperboard";
import TvIcon from "@lucide/svelte/icons/tv";
import type { Snippet } from "svelte";
import { artworkUrl, posterSrcset } from "$lib/browse.ts";

const {
  artworkId,
  title,
  sizes,
  kind = "movie",
  loading = "lazy",
  children,
}: {
  artworkId: string | null;
  title: string;
  sizes: string;
  kind?: "movie" | "show" | "season" | "episode";
  loading?: "lazy" | "eager";
  children?: Snippet;
} = $props();

let loaded = $state(false);
let failed = $state(false);
const Icon = $derived(kind === "movie" ? ClapperboardIcon : TvIcon);
</script>

<span
  class="relative block aspect-[2/3] overflow-hidden rounded-poster bg-elevated after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-label/8"
>
  {#if artworkId && !failed}
    <img
      src={artworkUrl(artworkId, 320)}
      srcset={posterSrcset(artworkId)}
      {sizes}
      alt=""
      {loading}
      decoding="async"
      onload={() => (loaded = true)}
      onerror={() => (failed = true)}
      class={loaded
        ? "size-full object-cover opacity-100 transition-opacity duration-(--duration-slow)"
        : "size-full object-cover opacity-0 transition-opacity duration-(--duration-slow)"}
    />
  {:else}
    <span
      class="absolute inset-0 bg-linear-to-b from-fill to-fill-strong"
      aria-hidden="true"
    >
      <Icon class="absolute top-3 left-3 size-5 text-label-tertiary" />
      <span
        class="absolute right-0 bottom-0 left-0 p-3.5 text-headline font-semibold text-label line-clamp-4"
        >{title}</span
      >
    </span>
  {/if}
  {@render children?.()}
</span>
