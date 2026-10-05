<script lang="ts">
import ClapperboardIcon from "@lucide/svelte/icons/clapperboard";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import { heroSlides, isFresh } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import HeroCarousel from "$lib/components/HeroCarousel.svelte";
import LandscapeCard from "$lib/components/LandscapeCard.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import Shelf, { shelfColumns } from "$lib/components/Shelf.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import { resource } from "$lib/resource.svelte.ts";

const home = resource(() => client.shelves.home());
const now = new Date();
const slides = $derived(home.data === undefined ? [] : heroSlides(home.data));

const landscapeShelves = new Set(["continue-watching", "next-up"]);
const skeletonSizes = ["landscape", "poster"] as const;
</script>

<svelte:head>
  <title>Pendia</title>
</svelte:head>

<h1 class={slides.length > 0 ? "sr-only" : "pt-4 pr-14 text-large-title lg:sr-only"}
  >Home</h1
>

{#if home.failure}
  <div class="pt-5"><Failure failure={home.failure} /></div>
{:else if home.data === undefined}
  <div class="bleed" aria-hidden="true">
    <Skeleton
      class="h-[min(78svh,44rem)] w-full lg:h-[min(82svh,max(30rem,56vw))] rounded-none"
    />
  </div>
  <div class="flex flex-col gap-10 pt-8 lg:gap-12 lg:pt-10" aria-hidden="true">
    {#each skeletonSizes as size (size)}
      <section>
        <div class="flex h-8 items-center">
          <Skeleton class="h-6 w-40" />
        </div>
        <ul
          class="bleed mt-2 -mb-4 grid grid-flow-col gap-4 overflow-hidden pt-3 pb-6 ps-(--shell-start) pe-(--gutter) lg:gap-5 {shelfColumns[
            size
          ]}"
        >
          {#each { length: 7 } as _, j (j)}
            <li>
              <Skeleton
                class="block rounded-poster {size === 'landscape'
                  ? 'aspect-video'
                  : 'aspect-[2/3]'}"
              />
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
{:else if home.data.length === 0}
  <div
    class="flex min-h-[50svh] flex-col items-center justify-center gap-3 text-center"
  >
    <ClapperboardIcon class="size-10 text-label-tertiary" />
    <h2 class="text-title-2">Nothing to watch yet</h2>
    {#if page.data.me.admin}
      <Button href="/admin/libraries">Add a library</Button>
    {:else}
      <p class="text-subheadline text-label-secondary">
        Titles appear here once an admin adds a library.
      </p>
    {/if}
  </div>
{:else}
  {#if slides.length > 0}
    <HeroCarousel {slides} />
  {/if}
  <div class="flex flex-col gap-10 pt-8 lg:gap-12 lg:pt-10">
    {#each home.data as shelf (shelf.id)}
      {#if landscapeShelves.has(shelf.id)}
        <Shelf title={shelf.title} id="shelf-{shelf.id}" size="landscape">
          {#each shelf.entries as entry (entry.item.id)}
            <li>
              <LandscapeCard
                card={entry.item}
                progress={entry.progress}
                fresh={shelf.id === "next-up" && isFresh(entry.item, now)}
              />
            </li>
          {/each}
        </Shelf>
      {:else}
        <Shelf title={shelf.title} id="shelf-{shelf.id}">
          {#each shelf.entries as entry (entry.item.id)}
            <li><PosterCard card={entry.item} progress={entry.progress} /></li>
          {/each}
        </Shelf>
      {/if}
    {/each}
  </div>
{/if}
