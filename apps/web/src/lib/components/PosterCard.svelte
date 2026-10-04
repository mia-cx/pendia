<script lang="ts">
import {
  type BrowseCard,
  episodeCode,
  type ItemCard,
  itemHref,
} from "$lib/browse.ts";
import Poster from "$lib/components/Poster.svelte";

const {
  card,
  progress = null,
}: {
  card: ItemCard | BrowseCard;
  progress?: { positionSeconds: number; durationSeconds: number | null } | null;
} = $props();

const context = $derived("show" in card ? card : null);
const href = $derived(itemHref(card));
// An Episode or Season without its own poster borrows its Show's.
const posterId = $derived(
  card.posterArtworkId ?? context?.show?.posterArtworkId ?? null,
);
const caption = $derived.by(() => {
  if (context?.kind === "episode") {
    const code = episodeCode(context);
    const show = context.show?.title;
    return [show, code].filter(Boolean).join(" · ");
  }
  if (card.kind === "season") return null;
  return card.year === null ? null : String(card.year);
});
const fraction = $derived(
  progress === null || !progress.durationSeconds
    ? null
    : Math.min(1, progress.positionSeconds / progress.durationSeconds),
);
</script>

<svelte:element this={href === null ? "div" : "a"} {href} class="card">
  <Poster
    artworkId={posterId}
    title={card.title}
    sizes="(max-width: 640px) 33vw, 180px"
  >
    {#if fraction !== null}
      <span class="progress" aria-hidden="true">
        <span style:width={`${fraction * 100}%`}></span>
      </span>
    {/if}
  </Poster>
  <span class="title">{card.title}</span>
  {#if fraction !== null}
    <span class="sr-only">{Math.round(fraction * 100)}% watched</span>
  {/if}
  {#if caption}
    <span class="caption">{caption}</span>
  {/if}
</svelte:element>

<style>
  .card {
    display: grid;
    align-content: start;
    gap: 2px;
    min-width: 0;
    color: var(--ink);
    text-decoration: none;
  }

  .card > :global(.frame) {
    margin-bottom: 6px;
  }

  a.card:hover > :global(.frame) {
    outline: 2px solid var(--signal);
    outline-offset: 2px;
  }

  .progress {
    position: absolute;
    right: 8px;
    bottom: 8px;
    left: 8px;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
    background: oklch(100% 0 0deg / 35%);
  }

  .progress span {
    display: block;
    height: 100%;
    background: var(--signal);
  }

  .title {
    display: -webkit-box;
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .caption {
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
