<script lang="ts">
import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
import PlayIcon from "@lucide/svelte/icons/play";
import { client } from "$lib/api.ts";
import {
  episodeCode,
  fallbackHue,
  formatBytes,
  formatDuration,
  type ItemDetail,
  landscapeArtwork,
  upNextEpisode,
} from "$lib/browse.ts";
import AmbientBackdrop from "$lib/components/AmbientBackdrop.svelte";
import CreditRow from "$lib/components/CreditRow.svelte";
import DetailBar from "$lib/components/DetailBar.svelte";
import EpisodeCard from "$lib/components/EpisodeCard.svelte";
import Failure from "$lib/components/Failure.svelte";
import FormatBadges from "$lib/components/FormatBadges.svelte";
import Hero from "$lib/components/Hero.svelte";
import ItemActions from "$lib/components/ItemActions.svelte";
import Overview from "$lib/components/Overview.svelte";
import Shelf from "$lib/components/Shelf.svelte";
import StoreRequest from "$lib/components/StoreRequest.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import { resource } from "$lib/resource.svelte.ts";

const { id }: { id: string } = $props();

const item = resource(() => client.items.get({ id }));

// A Show's Season details load once the Show arrives, for the up next pill
// and the episode shelf. An Episode's parent Season loads for the More shelf.
const related = resource(async () => {
  const detail = item.data;
  if (detail?.kind === "show")
    return Promise.all(
      detail.children.map((season) => client.items.get({ id: season.id })),
    );
  if (detail?.kind === "episode" && detail.parentId !== null)
    return [await client.items.get({ id: detail.parentId })];
  return [] as ItemDetail[];
});

$effect(() => {
  const detail = item.data;
  if (detail && (detail.kind === "show" || detail.kind === "episode"))
    void related.reload();
});

let hero = $state<HTMLElement | undefined>(undefined);

// The Show page's chosen Season; the up next Episode picks the default.
let chosen = $state<string | undefined>(undefined);

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const seasonLabel = (seasonNumber: number | null) =>
  seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;

/** A Show's Seasons in order, Specials last. */
const orderedSeasons = (detail: ItemDetail) =>
  detail.children.toSorted(
    (a, b) => (a.seasonNumber === 0 ? 1 : 0) - (b.seasonNumber === 0 ? 1 : 0),
  );

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
  {@const ambient = landscapeArtwork(detail) ?? heroPoster(detail)}
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
  {@const episodes =
    detail.kind === "show"
      ? (related.data ?? []).flatMap((season) => season.children)
      : detail.children}
  <div class="bleed -mt-14" bind:this={hero}>
    <Hero
      backdropId={landscapeArtwork(detail)}
      posterId={heroPoster(detail)}
      logoId={detail.kind === "movie" || detail.kind === "show"
        ? detail.logoArtworkId
        : null}
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
        {#if detail.kind === "show" && detail.children.length > 0}
          {#if detail.year !== null}
            <span aria-hidden="true">·</span>
          {/if}
          {count(detail.children.length, "season", "seasons")}
        {/if}
        {#if runtime !== null}
          {#if detail.year !== null || (detail.kind === "show" && detail.children.length > 0)}
            <span aria-hidden="true">·</span>
          {/if}
          {formatDuration(runtime)}
        {/if}
        <FormatBadges versions={detail.versions} />
      </p>
      <div class="mt-2">
        <ItemActions {detail} {episodes} reload={item.reload} />
      </div>
    </Hero>
  </div>

  <div class="flex flex-col gap-10 pt-8 lg:gap-12 lg:pt-10">
    {#if detail.kind === "show" && detail.children.length > 0}
      {@const next = upNextEpisode(episodes)}
      {@const seasons = orderedSeasons(detail)}
      {@const selected =
        (chosen !== undefined
          ? seasons.find((season) => season.id === chosen)
          : undefined) ??
        seasons.find((season) => season.id === next?.parentId) ??
        seasons[0]}
      {@const chosenDetail = related.data?.find(
        (season) => season.id === selected?.id,
      )}
      {#if selected !== undefined}
        {#key selected.id}
          <Shelf id="episodes" size="landscape">
            {#snippet heading()}
              {#if seasons.length > 1}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger
                    class="inline-flex items-center gap-1.5"
                    aria-label="{selected.title}, choose season"
                  >
                    {selected.title}
                    <ChevronsUpDownIcon class="size-5" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="start">
                    <DropdownMenu.RadioGroup
                      value={selected.id}
                      onValueChange={(value) => (chosen = value)}
                    >
                      {#each seasons as season (season.id)}
                        <DropdownMenu.RadioItem value={season.id}>
                          {season.title}
                        </DropdownMenu.RadioItem>
                      {/each}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              {:else}
                {selected.title}
              {/if}
            {/snippet}
            {#if related.loading || related.data === undefined}
              {#each [0, 1, 2, 3] as n (n)}
                <li class="flex flex-col gap-1" aria-hidden="true">
                  <Skeleton class="aspect-video w-full rounded-poster" />
                  <Skeleton class="mt-2 h-4 w-24" />
                  <Skeleton class="h-5 w-40" />
                  <Skeleton class="h-14 w-full" />
                </li>
              {/each}
            {:else if related.failure}
              <li class="col-span-full"><Failure failure={related.failure} /></li>
            {:else if chosenDetail}
              {#each chosenDetail.children as episode (episode.id)}
                <li><EpisodeCard {episode} /></li>
              {/each}
            {/if}
          </Shelf>
        {/key}
      {/if}
    {/if}

    {#if detail.kind === "season" && detail.children.length > 0}
      <section aria-labelledby="episodes">
        <h2 id="episodes" class="mb-3 text-title-2">Episodes</h2>
        <ul
          class="grid gap-x-4 gap-y-6 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]"
        >
          {#each detail.children as episode (episode.id)}
            <li><EpisodeCard {episode} /></li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if detail.kind === "episode"}
      {@const season = related.data?.[0]}
      {#if season && season.children.length > 1}
        <Shelf
          id="more-in"
          title="More in {season.title}"
          size="landscape"
        >
          {#each season.children as episode (episode.id)}
            <li><EpisodeCard {episode} current={episode.id === detail.id} /></li>
          {/each}
        </Shelf>
      {:else if related.loading}
        <Shelf
          id="more-in"
          title="More in {seasonLabel(detail.seasonNumber)}"
          size="landscape"
        >
          {#each [0, 1, 2, 3] as n (n)}
            <li aria-hidden="true">
              <Skeleton class="aspect-video w-full rounded-poster" />
            </li>
          {/each}
        </Shelf>
      {/if}
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
