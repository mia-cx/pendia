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
// And its fallback names the Show, which reads in a frame; an Episode's own
// title is "Episode 1".
const posterTitle = $derived(context?.show?.title ?? card.title);
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

<svelte:element
  this={href === null ? "div" : "a"}
  {href}
  class="group grid min-w-0 content-start gap-0.5 text-label no-underline outline-none"
>
  <span
    class="relative block transition-[transform,box-shadow] duration-(--duration-fast) ease-smooth-out group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-tint group-focus-visible:outline-offset-2 motion-safe:group-hover:-translate-y-1 motion-safe:group-hover:scale-[1.03] motion-safe:group-hover:shadow-lift motion-safe:group-hover:duration-(--duration-fast) motion-safe:group-hover:ease-spring motion-safe:group-focus-visible:-translate-y-1 motion-safe:group-focus-visible:scale-[1.03] motion-safe:group-focus-visible:shadow-lift rounded-poster"
  >
    <Poster
      artworkId={posterId}
      title={posterTitle}
      kind={card.kind}
      sizes="(max-width: 640px) 33vw, 180px"
    >
      {#if fraction !== null && posterId !== null}
        <span
          class="absolute inset-x-0 bottom-0 h-[30%] bg-linear-to-t from-black/60 to-transparent"
          aria-hidden="true"
        ></span>
        <span
          class="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-white/35"
          aria-hidden="true"
        >
          <span class="block h-full bg-tint" style:width={`${fraction * 100}%`}
          ></span>
        </span>
      {/if}
    </Poster>
  </span>
  <span class="mt-2 text-subheadline font-medium text-label line-clamp-2"
    >{card.title}</span
  >
  {#if fraction !== null}
    <span class="sr-only">{Math.round(fraction * 100)}% watched</span>
  {/if}
  {#if caption}
    <span class="truncate text-footnote text-label-secondary">{caption}</span>
  {/if}
</svelte:element>
