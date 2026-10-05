<script lang="ts">
import {
  type BrowseCard,
  cardLabel,
  type ItemCard,
  itemHref,
} from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";

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
// Its fallback names the Show, which reads in a frame; an Episode's own
// title is "Episode 1".
const posterTitle = $derived(context?.show?.title ?? card.title);
const caption = $derived(card.year === null ? null : String(card.year));
const fraction = $derived(
  progress === null || !progress.durationSeconds
    ? null
    : Math.min(1, progress.positionSeconds / progress.durationSeconds),
);
const label = $derived(
  fraction === null
    ? cardLabel(card)
    : `${cardLabel(card)}, ${Math.round(fraction * 100)}% watched`,
);
</script>

<svelte:element
  this={href === null ? "div" : "a"}
  {href}
  aria-label={href === null ? undefined : label}
  class="group block min-w-0 text-label no-underline outline-none"
>
  <span
    class="relative block transition-[transform,box-shadow] duration-(--duration-fast) ease-smooth-out group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-tint group-focus-visible:outline-offset-2 motion-safe:group-hover:-translate-y-1 motion-safe:group-hover:scale-[1.03] motion-safe:group-hover:shadow-lift motion-safe:group-hover:duration-(--duration-fast) motion-safe:group-hover:ease-spring motion-safe:group-focus-visible:-translate-y-1 motion-safe:group-focus-visible:scale-[1.03] motion-safe:group-focus-visible:shadow-lift rounded-poster"
  >
    <Artwork
      artworkId={posterId}
      title={posterTitle}
      kind={card.kind}
      {caption}
      sizes="(max-width: 640px) 33vw, 180px"
    >
      {#if fraction !== null && posterId !== null}
        <span
          class="absolute inset-x-0 bottom-0 h-[30%] bg-linear-to-t from-black/60 to-transparent"
          aria-hidden="true"
        ></span>
      {/if}
      {#if fraction !== null}
        <span
          class="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full {posterId !==
          null
            ? 'bg-white/35'
            : 'bg-fill-strong'}"
          aria-hidden="true"
        >
          <span class="block h-full bg-tint" style:width={`${fraction * 100}%`}
          ></span>
        </span>
      {/if}
    </Artwork>
  </span>
  {#if card.kind === "season"}
    <span class="mt-2 block truncate text-subheadline text-label"
      >{card.title}</span
    >
  {/if}
  {#if href === null}
    <span class="sr-only">{label}</span>
  {/if}
</svelte:element>
