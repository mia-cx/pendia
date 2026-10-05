<script lang="ts">
import ClapperboardIcon from "@lucide/svelte/icons/clapperboard";
import TvIcon from "@lucide/svelte/icons/tv";
import type { Snippet } from "svelte";
import {
  artworkSrcset,
  artworkUrl,
  fallbackHue,
  landscapeWidths,
  posterWidths,
} from "$lib/browse.ts";

const {
  artworkId,
  title,
  sizes,
  shape = "poster",
  kind = "movie",
  loading = "lazy",
  caption = null,
  fallbackTitle = true,
  children,
}: {
  artworkId: string | null;
  title: string;
  sizes: string;
  shape?: "poster" | "landscape";
  kind?: "movie" | "show" | "season" | "episode";
  loading?: "lazy" | "eager";
  /** The line under the fallback title, such as the year. */
  caption?: string | null;
  /** Whether the fallback prints the title; landscape cards draw their own. */
  fallbackTitle?: boolean;
  children?: Snippet;
} = $props();

let loaded = $state(false);
let failed = $state(false);
const Icon = $derived(kind === "movie" ? ClapperboardIcon : TvIcon);
const widths = $derived(shape === "poster" ? posterWidths : landscapeWidths);
const showsTitle = $derived(shape === "poster" && fallbackTitle);
</script>

<span
  class="relative block overflow-hidden rounded-poster bg-elevated after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-label/8 {shape ===
  'poster'
    ? 'aspect-[2/3]'
    : 'aspect-video'}"
>
  {#if artworkId && !failed}
    <img
      src={artworkUrl(artworkId, widths[0] ?? 320)}
      srcset={artworkSrcset(artworkId, widths)}
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
      class="absolute inset-0 artwork-fallback"
      style:--fallback-hue={fallbackHue(title)}
      aria-hidden="true"
    >
      {#if showsTitle}
        <Icon class="absolute top-3.5 left-3.5 size-5 text-label-tertiary" />
        <span
          class="absolute right-0 bottom-0 left-0 flex flex-col gap-1 p-3.5 text-left"
        >
          <span
            class="text-title-3 font-bold leading-tight text-balance text-label line-clamp-4"
            >{title}</span
          >
          {#if caption}
            <span class="text-footnote text-label-secondary">{caption}</span>
          {/if}
        </span>
      {/if}
    </span>
  {/if}
  {@render children?.()}
</span>
