<script lang="ts">
import PlayIcon from "@lucide/svelte/icons/play";
import { client } from "$lib/api.ts";
import {
  episodeCode,
  fallbackHue,
  formatBytes,
  formatDuration,
  type ItemDetail,
  itemHref,
} from "$lib/browse.ts";
import AmbientBackdrop from "$lib/components/AmbientBackdrop.svelte";
import CreditRow from "$lib/components/CreditRow.svelte";
import DetailBar from "$lib/components/DetailBar.svelte";
import Failure from "$lib/components/Failure.svelte";
import FormatBadges from "$lib/components/FormatBadges.svelte";
import Hero from "$lib/components/Hero.svelte";
import ItemActions from "$lib/components/ItemActions.svelte";
import Overview from "$lib/components/Overview.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import PosterGrid from "$lib/components/PosterGrid.svelte";
import StoreRequest from "$lib/components/StoreRequest.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import { resource } from "$lib/resource.svelte.ts";

const { id }: { id: string } = $props();

const item = resource(() => client.items.get({ id }));

let hero = $state<HTMLElement | undefined>(undefined);

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const seasonLabel = (seasonNumber: number | null) =>
  seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;

/** The title's hue, feeding the art-free hero and the ambient wash. */
const heroHue = (detail: ItemDetail) => fallbackHue(detail.title);

/** The poster the hero washes with when the Item has no backdrop. */
const heroPoster = (detail: ItemDetail) =>
  detail.posterArtworkId ?? detail.show?.posterArtworkId ?? null;

function metaLine(detail: ItemDetail): string[] {
  const genres = detail.genres.slice(0, 2);
  if (detail.kind === "movie") return ["Movie", ...genres];
  if (detail.kind === "show") return ["TV show", ...genres];
  if (detail.kind === "season")
    return ["TV show", count(detail.children.length, "episode", "episodes")];
  return [episodeCode(detail) ?? "Episode", ...genres];
}

/** Where Back lands for a cold-opened page. */
function fallbackHref(detail: ItemDetail): string {
  if (detail.kind === "movie") return "/movies";
  if (detail.kind === "show") return "/shows";
  if (detail.kind === "season")
    return detail.show === null ? "/shows" : `/shows/${detail.show.id}`;
  return detail.show !== null && detail.parentId !== null
    ? `/shows/${detail.show.id}/seasons/${detail.parentId}`
    : "/shows";
}

/** The hero aside: starring actors, then the director or creator. */
function creditsAside(detail: ItemDetail) {
  const actors = detail.credits
    .filter((credit) => credit.role === "actor")
    .slice(0, 3)
    .map((credit) => credit.name);
  const lead = detail.credits.find(
    (credit) =>
      credit.role === "director" ||
      (detail.kind === "show" && credit.role === "creator"),
  );
  return {
    actors,
    lead:
      lead === undefined
        ? null
        : {
            label: lead.role === "creator" ? "Created by" : "Director",
            name: lead.name,
          },
  };
}
</script>

<svelte:head>
  <title>{item.data ? `${item.data.title} · Pendia` : "Pendia"}</title>
</svelte:head>

{#if item.data}
  {@const detail = item.data}
  {@const ambient =
    detail.backdropArtworkId ?? heroPoster(detail)}
  <AmbientBackdrop artworkId={ambient} hue={heroHue(detail)} />
{/if}

<DetailBar
  title={item.data?.title ?? ""}
  fallbackHref={item.data ? fallbackHref(item.data) : "/"}
  {hero}
/>

{#if item.failure}
  <div class="pt-5"><Failure failure={item.failure} /></div>
{:else if item.data === undefined}
  <div class="bleed -mt-14" aria-hidden="true">
    <Skeleton
      class="h-[min(78svh,44rem)] w-full rounded-none lg:h-[min(82svh,max(30rem,56vw))]"
    />
  </div>
{:else}
  {@const detail = item.data}
  {@const billing = creditsAside(detail)}
  {@const runtime = detail.versions[0]?.durationSeconds ?? null}
  <div class="bleed -mt-14" bind:this={hero}>
    <Hero
      backdropId={detail.backdropArtworkId}
      posterId={heroPoster(detail)}
      logoId={detail.kind === "episode" ? null : detail.logoArtworkId}
      title={detail.title}
      heading="h1"
      eager
      hue={heroHue(detail)}
    >
      {#snippet eyebrow()}
        {#if detail.show && (detail.kind === "season" || detail.kind === "episode")}
          <p class="text-title-3 text-white/90">
            <a href="/shows/{detail.show.id}" class="hover:underline"
              >{detail.show.title}</a
            >
            {#if detail.kind === "episode" && detail.parentId !== null}
              <span aria-hidden="true"> · </span>
              <a
                href="/shows/{detail.show.id}/seasons/{detail.parentId}"
                class="hover:underline">{seasonLabel(detail.seasonNumber)}</a
              >
            {/if}
          </p>
        {/if}
      {/snippet}
      {#snippet aside()}
        {#if billing.actors.length > 0 || billing.lead !== null}
          <p class="text-white">
            {#if billing.actors.length > 0}
              <span class="text-white/60">Starring</span>
              {billing.actors.join(", ")}
            {/if}
          </p>
          {#if billing.lead !== null}
            <p class="text-white">
              <span class="text-white/60">{billing.lead.label}</span>
              {billing.lead.name}
            </p>
          {/if}
        {/if}
      {/snippet}
      <p
        class="flex flex-wrap items-center gap-x-2 gap-y-1 text-subheadline text-white/75"
      >
        {metaLine(detail).join(" · ")}
        {#if detail.contentRating}
          <span
            class="rounded-[4px] border border-white/40 px-1 text-caption-1 font-semibold"
            >{detail.contentRating}</span
          >
        {/if}
      </p>
      {#if detail.overview}
        <Overview text={detail.overview} title={detail.title} />
      {/if}
      <p
        class="flex flex-wrap items-center gap-x-2 gap-y-1 text-subheadline text-white/75 tabular-nums"
      >
        {#if detail.year !== null}{detail.year}{/if}
        {#if runtime !== null}
          {#if detail.year !== null}
            <span aria-hidden="true">·</span>
          {/if}
          {formatDuration(runtime)}
        {/if}
        <FormatBadges versions={detail.versions} />
      </p>
      <div class="mt-2">
        <ItemActions {detail} reload={item.reload} />
      </div>
    </Hero>
  </div>

  <div class="flex flex-col gap-10 pt-8 lg:gap-12 lg:pt-10">
    {#if detail.kind === "show" && detail.children.length > 0}
      <section aria-labelledby="seasons">
        <h2 id="seasons" class="mb-3 text-title-2">Seasons</h2>
        <PosterGrid>
          {#each detail.children as season (season.id)}
            <li><PosterCard card={season} /></li>
          {/each}
        </PosterGrid>
      </section>
    {/if}

    {#if detail.kind === "season" && detail.children.length > 0}
      <section aria-labelledby="episodes">
        <h2 id="episodes" class="mb-3 text-title-2">Episodes</h2>
        <ol class="max-w-3xl">
          {#each detail.children as episode (episode.id)}
            <li class="border-b border-separator last:border-0">
              <a
                href={itemHref(episode)}
                class="flex items-baseline gap-4 px-1 py-3 text-label no-underline hover:bg-fill"
              >
                <span
                  class="w-6 shrink-0 text-right text-subheadline text-label-secondary tabular-nums"
                  >{episode.episodeNumber}</span
                >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-body">{episode.title}</span>
                  {#if episode.durationSeconds !== null}
                    <span
                      class="block text-footnote text-label-secondary tabular-nums"
                      >{formatDuration(episode.durationSeconds)}</span
                    >
                  {/if}
                </span>
              </a>
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    {#if (detail.kind === "movie" || detail.kind === "episode") && detail.versions.length > 0}
      <section aria-labelledby="versions">
        <h2 id="versions" class="mb-3 text-title-2">Versions</h2>
        <ul class="max-w-3xl rounded-xl bg-elevated">
          {#each detail.versions as version (version.id)}
            <li
              class="flex items-center gap-4 border-b border-separator px-4 py-3 last:border-0"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate text-body">{version.label}</p>
                <p class="text-footnote text-label-secondary tabular-nums">
                  {[
                    version.durationSeconds === null
                      ? null
                      : formatDuration(version.durationSeconds),
                    formatBytes(version.bytes),
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </p>
              </div>
              <Button
                variant="secondary"
                size="icon"
                href="/play/{detail.id}?version={version.id}"
                aria-label="Play {version.label}"
              >
                <PlayIcon />
              </Button>
            </li>
          {/each}
        </ul>
        <StoreRequest {detail} />
      </section>
    {/if}

    <CreditRow credits={detail.credits} />
  </div>
{/if}
