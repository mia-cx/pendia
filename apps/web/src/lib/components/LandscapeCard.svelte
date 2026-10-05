<script lang="ts">
import {
  artworkUrl,
  type BrowseCard,
  cardLabel,
  episodeCode,
  itemHref,
  landscapeArtwork,
  timeLeft,
  titleArt,
} from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import CardMenu from "$lib/components/CardMenu.svelte";

const {
  card,
  progress = null,
  fresh = false,
}: {
  card: BrowseCard;
  progress?: { positionSeconds: number; durationSeconds: number | null } | null;
  fresh?: boolean;
} = $props();

// Movies and Episodes play straight from the card; others open their page.
const href = $derived(
  card.kind === "movie" || card.kind === "episode"
    ? `/play/${card.id}`
    : itemHref(card),
);
const art = $derived(titleArt(card));
const left = $derived(progress === null ? null : timeLeft(progress));
const label = $derived(
  `${progress ? "Resume" : "Play"} ${cardLabel(card)}${left ? `, ${left}` : ""}`,
);
const meta = $derived.by(() => {
  const parts: string[] = [];
  if (card.kind === "episode") {
    const code = episodeCode(card);
    if (code !== null) parts.push(code);
    parts.push(left ?? card.title);
  } else if (left !== null) parts.push(left);
  return parts.join(" · ");
});
const fraction = $derived(
  progress === null || !progress.durationSeconds
    ? null
    : Math.min(1, progress.positionSeconds / progress.durationSeconds),
);
const artworkId = $derived(landscapeArtwork(card));
</script>

<div class="group relative dark [color-scheme:dark]">
  <div
    class="relative transition-[transform,box-shadow] duration-(--duration-fast) ease-smooth-out motion-safe:group-hover:-translate-y-1 motion-safe:group-hover:scale-[1.02] motion-safe:group-hover:shadow-lift motion-safe:group-hover:duration-(--duration-fast) motion-safe:group-hover:ease-spring motion-safe:group-has-[a:focus-visible]:-translate-y-1 motion-safe:group-has-[a:focus-visible]:scale-[1.02] motion-safe:group-has-[a:focus-visible]:shadow-lift rounded-poster"
  >
    {#if href === null}
      <div class="block rounded-poster">
        <span class="sr-only">{label}</span>
        {@render inner()}
      </div>
    {:else}
      <a {href} aria-label={label} class="block rounded-poster outline-none">
        {@render inner()}
      </a>
    {/if}
    <div class="absolute right-2 bottom-2">
      <CardMenu {card} {progress} />
    </div>
  </div>
</div>

{#snippet inner()}
  <Artwork
    shape="landscape"
    fallbackTitle={false}
    {artworkId}
    title={art.title}
    kind={card.kind}
    sizes="(max-width: 1023px) 80vw, 320px"
  >
    <span
      class="absolute inset-x-0 bottom-0 h-full bg-linear-to-t from-black/80 via-black/30 via-45% to-transparent to-75% contrast-more:from-black contrast-more:via-black/70"
      aria-hidden="true"
    ></span>
    <span
      class="absolute inset-x-3.5 bottom-3 flex flex-col gap-1.5 pe-9 text-left"
    >
      {#if art.logoId}
        <img
          src={artworkUrl(art.logoId, 480)}
          alt=""
          class="max-h-11 max-w-[70%] w-auto object-contain object-left-bottom drop-shadow lg:max-h-12"
        />
      {:else}
        <span class="text-headline text-white line-clamp-2">{art.title}</span>
      {/if}
      {#if meta}
        <span
          class="text-footnote font-medium text-white/80 tabular-nums truncate"
          >{meta}</span
        >
      {/if}
      {#if fraction !== null}
        <span
          class="h-1 overflow-hidden rounded-full bg-white/25"
          aria-hidden="true"
        >
          <span class="block h-full bg-tint" style:width={`${fraction * 100}%`}
          ></span>
        </span>
      {/if}
    </span>
    {#if fresh}
      <span
        class="absolute top-2.5 left-2.5 rounded-sm px-1.5 py-0.5 text-caption-1 font-semibold text-white material-thick"
        >New</span
      >
    {/if}
  </Artwork>
{/snippet}
