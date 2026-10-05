<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import {
  type DetailChild,
  formatDuration,
  landscapeArtwork,
  timeLeft,
} from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import CardMenu from "$lib/components/CardMenu.svelte";

const {
  episode,
  current = false,
}: {
  episode: DetailChild;
  /** Marks the card as the page's own Episode: aria-current and a tint ring. */
  current?: boolean;
} = $props();

const completed = $derived(episode.progress?.completed === true);
const watching = $derived(
  episode.progress !== null &&
    !episode.progress.completed &&
    episode.progress.positionSeconds > 0,
);
const progress = $derived(
  watching
    ? {
        positionSeconds: episode.progress?.positionSeconds ?? 0,
        durationSeconds: episode.durationSeconds,
      }
    : null,
);
const left = $derived(progress === null ? null : timeLeft(progress));
const fraction = $derived(
  progress === null || !progress.durationSeconds
    ? null
    : Math.min(1, progress.positionSeconds / progress.durationSeconds),
);

const numbers = $derived(
  episode.episodeNumber === null
    ? null
    : episode.episodeEndNumber === null
      ? `Episode ${episode.episodeNumber}`
      : `Episodes ${episode.episodeNumber}–${episode.episodeEndNumber}`,
);
const eyebrow = $derived(numbers === null ? "Episode" : numbers.toUpperCase());
const label = $derived(
  `${watching ? "Resume" : "Play"} ${numbers ?? "episode"}, ${episode.title}${left ? `, ${left}` : ""}`,
);
const artworkId = $derived(landscapeArtwork(episode));
</script>

<div class="group relative">
  <div
    class="relative overflow-hidden rounded-poster bg-elevated transition-[transform,box-shadow] duration-(--duration-fast) ease-smooth-out group-has-[a:focus-visible]:outline group-has-[a:focus-visible]:outline-2 group-has-[a:focus-visible]:outline-tint group-has-[a:focus-visible]:outline-offset-2 motion-safe:group-hover:-translate-y-1 motion-safe:group-hover:scale-[1.02] motion-safe:group-hover:shadow-lift motion-safe:group-hover:duration-(--duration-fast) motion-safe:group-hover:ease-spring motion-safe:group-has-[a:focus-visible]:-translate-y-1 motion-safe:group-has-[a:focus-visible]:scale-[1.02] motion-safe:group-has-[a:focus-visible]:shadow-lift {current
      ? 'ring-2 ring-tint'
      : 'ring-1 ring-label/8'}"
  >
    <a
      href="/play/{episode.id}"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      class="block rounded-poster outline-none"
    >
      <Artwork
        shape="landscape"
        fallbackTitle={false}
        {artworkId}
        title={episode.title}
        kind="episode"
        sizes="(max-width: 1023px) 80vw, 304px"
      >
        {#if fraction !== null}
          <span
            class="absolute inset-x-0 bottom-0 h-1 bg-white/25"
            aria-hidden="true"
          >
            <span class="block h-full bg-tint" style:width="{fraction * 100}%"
            ></span>
          </span>
        {/if}
      </Artwork>
      <div class="flex flex-col gap-1 p-3">
        <span
          class="text-caption-1 font-semibold tracking-wide uppercase text-label-secondary"
          >{eyebrow}</span
        >
        <span class="text-headline line-clamp-1">{episode.title}</span>
        <span
          class="text-footnote text-label-secondary line-clamp-3 min-h-[3lh]"
          >{episode.overview ?? ""}</span
        >
        <span
          class="mt-1 flex items-center gap-1.5 text-footnote text-label-secondary tabular-nums"
        >
          {#if completed}
            <CheckIcon class="size-3.5" /> Watched
          {:else if left !== null}
            {left}
          {:else if episode.durationSeconds !== null}
            {formatDuration(episode.durationSeconds)}
          {/if}
        </span>
      </div>
    </a>
    <div class="absolute right-3 bottom-3">
      <CardMenu card={episode} {progress} />
    </div>
  </div>
</div>
