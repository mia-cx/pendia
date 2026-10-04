<script lang="ts">
import ClapperboardIcon from "@lucide/svelte/icons/clapperboard";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import Shelf from "$lib/components/Shelf.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import { resource } from "$lib/resource.svelte.ts";

const home = resource(() => client.shelves.home());
</script>

<svelte:head>
  <title>Pendia</title>
</svelte:head>

<h1 class="pt-4 pr-14 text-large-title lg:sr-only">Home</h1>

<div class="flex flex-col gap-9 pt-5 lg:gap-11 lg:pt-6">
  {#if home.failure}
    <Failure failure={home.failure} />
  {:else if home.data === undefined}
    {#each { length: 2 } as _, i (i)}
      <section aria-hidden="true">
        <div class="flex h-8 items-center">
          <Skeleton class="h-6 w-40" />
        </div>
        <ul
          class="mt-2 -mb-4 mr-[calc(-1*var(--gutter))] ml-[calc(-1*var(--shell-start))] grid auto-cols-[clamp(7.5rem,28vw,10.5rem)] grid-flow-col gap-4 overflow-hidden pt-3 pb-6 pr-(--gutter) pl-(--shell-start) lg:auto-cols-[11rem] lg:gap-5"
        >
          {#each { length: 7 } as _, j (j)}
            <li>
              <Skeleton class="block aspect-[2/3] rounded-poster" />
              <Skeleton class="mt-2 h-5 w-3/4" />
              <Skeleton class="mt-1 h-[1.125rem] w-1/2" />
            </li>
          {/each}
        </ul>
      </section>
    {/each}
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
    {#each home.data as shelf (shelf.id)}
      <Shelf title={shelf.title} id="shelf-{shelf.id}">
        {#each shelf.entries as entry (entry.item.id)}
          <li><PosterCard card={entry.item} progress={entry.progress} /></li>
        {/each}
      </Shelf>
    {/each}
  {/if}
</div>
