<script lang="ts">
import type { Snippet } from "svelte";
import { artworkUrl, posterSrcset } from "$lib/browse.ts";

const {
  artworkId,
  title,
  sizes,
  loading = "lazy",
  children,
}: {
  artworkId: string | null;
  title: string;
  sizes: string;
  loading?: "lazy" | "eager";
  children?: Snippet;
} = $props();
</script>

<span class="frame">
  {#if artworkId}
    <img
      src={artworkUrl(artworkId, 320)}
      srcset={posterSrcset(artworkId)}
      {sizes}
      alt=""
      {loading}
      decoding="async"
    />
  {:else}
    <span class="placeholder" aria-hidden="true">{title}</span>
  {/if}
  {@render children?.()}
</span>

<style>
  .frame {
    position: relative;
    display: block;
    overflow: hidden;
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-poster);
    background: var(--surface);
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    display: grid;
    height: 100%;
    padding: 12px;
    place-items: center;
    color: var(--muted);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.25;
    text-align: center;
    overflow-wrap: anywhere;
  }
</style>
