<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import InfoIcon from "@lucide/svelte/icons/info";
import PlayIcon from "@lucide/svelte/icons/play";
import { client } from "$lib/api.ts";
import {
  type heroSlides,
  episodeCode,
  type ItemDetail,
  itemHref,
  landscapeArtwork,
  titleArt,
} from "$lib/browse.ts";
import Hero from "$lib/components/Hero.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";

const {
  slides,
}: {
  slides: ReturnType<typeof heroSlides>;
} = $props();

let track = $state<HTMLDivElement | undefined>(undefined);
let current = $state(0);
// Detail rows arrive after the cards; the meta line reflows without jumping.
let details = $state<Record<string, ItemDetail | undefined>>({});

$effect(() => {
  for (const slide of slides) {
    if (slide.card.id in details) continue;
    client.items
      .get({ id: slide.card.id })
      .then((detail) => {
        details[slide.card.id] = detail;
      })
      .catch(() => {});
  }
});

function onscroll() {
  if (!track || track.clientWidth === 0) return;
  current = Math.round(track.scrollLeft / track.clientWidth);
}

function goTo(index: number) {
  if (!track) return;
  const wrapped = (index + slides.length) % slides.length;
  track.scrollTo({
    left: wrapped * track.clientWidth,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}

function metaLine(card: (typeof slides)[number]["card"]): string {
  const detail = details[card.id];
  const genres = (detail?.genres ?? []).slice(0, 2).join(", ");
  if (card.kind === "episode") {
    return [episodeCode(card), card.title]
      .filter((part) => part !== null)
      .join(" · ");
  }
  const medium = card.kind === "movie" ? "Movie" : "TV show";
  return [medium, genres, card.year]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

const multiple = $derived(slides.length > 1);
</script>

<section
  aria-roledescription="carousel"
  aria-label="Featured"
  class="bleed relative"
>
  <div
    bind:this={track}
    {onscroll}
    class="flex overflow-x-auto snap-x snap-mandatory overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  >
    {#each slides as slide, i (slide.card.id)}
      {@const card = slide.card}
      {@const art = titleArt(card)}
      {@const detail = details[card.id]}
      <div
        role="group"
        aria-roledescription="slide"
        aria-label="{i + 1} of {slides.length}"
        inert={i !== current}
        class="w-full shrink-0 snap-start"
      >
        <Hero
          backdropId={landscapeArtwork(card)}
          posterId={card.posterArtworkId}
          logoId={art.logoId}
          title={art.title}
          eager={i === 0}
        >
          <p class="text-subheadline text-label-secondary">{metaLine(card)}</p>
          <p class="text-callout text-label line-clamp-2 min-h-[2lh]">
            {detail?.overview ?? ""}
          </p>
          <div class="mt-2 flex items-center gap-3">
            {#if card.kind === "movie" || card.kind === "episode"}
              <Button size="pill" href="/play/{card.id}">
                <PlayIcon fill="currentColor" />
                {slide.progress ? "Resume" : "Play"}
              </Button>
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="glass"
                      size="icon-lg"
                      class="size-11"
                      href={itemHref(card) ?? "#"}
                      aria-label="Go to {card.kind}"
                    >
                      <InfoIcon />
                    </Button>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content>Go to {card.kind}</Tooltip.Content>
              </Tooltip.Root>
            {:else}
              <Button size="pill" href={itemHref(card) ?? "#"}>Go to show</Button
              >
            {/if}
          </div>
        </Hero>
      </div>
    {/each}
  </div>

  {#if multiple}
    <button
      type="button"
      aria-label="Previous"
      onclick={() => goTo(current - 1)}
      class="absolute top-1/2 left-[calc(var(--shell-start)-var(--gutter)+0.5rem)] hidden size-11 -translate-y-1/2 items-center justify-center text-white/75 transition-colors duration-(--duration-quick) hover:text-white pointer-fine:flex"
    >
      <ChevronLeftIcon class="size-9" stroke-width="1.25" />
    </button>
    <button
      type="button"
      aria-label="Next"
      onclick={() => goTo(current + 1)}
      class="absolute top-1/2 right-3 hidden size-11 -translate-y-1/2 items-center justify-center text-white/75 transition-colors duration-(--duration-quick) hover:text-white pointer-fine:flex"
    >
      <ChevronRightIcon class="size-9" stroke-width="1.25" />
    </button>
    <div
      class="absolute bottom-6 inset-x-0 flex justify-center ps-(--shell-start) pe-(--gutter)"
    >
      {#each slides as _, i (i)}
        <button
          type="button"
          aria-label="Show slide {i + 1}"
          aria-current={i === current ? "true" : undefined}
          onclick={() => goTo(i)}
          class="flex size-6 items-center justify-center"
        >
          <span
            class="size-2 rounded-full transition-colors duration-(--duration-quick) {i ===
            current
              ? 'bg-white'
              : 'bg-white/40'}"
          ></span>
        </button>
      {/each}
    </div>
  {/if}
</section>
