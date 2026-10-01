<script lang="ts">
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import type { ItemCard } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import { readFailure } from "$lib/errors.ts";

const query = $derived((page.url.searchParams.get("q") ?? "").trim());

let results = $state<{ query: string; cards: ItemCard[] } | undefined>(
  undefined,
);
// Results for an older query stay hidden until the current one answers.
const shown = $derived(results?.query === query ? results : undefined);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let generation = 0;

$effect(() => {
  const asked = query;
  const ticket = ++generation;
  failure = undefined;
  if (asked === "") {
    results = undefined;
    return;
  }
  client.items.search({ query: asked }).then(
    (cards) => {
      if (ticket === generation) results = { query: asked, cards: [...cards] };
    },
    (error: unknown) => {
      if (ticket === generation) failure = readFailure(error);
    },
  );
});
</script>

<svelte:head>
  <title>{query === "" ? "Search" : `${query} · Search`} · Pendia</title>
</svelte:head>

<h1>{query === "" ? "Search" : `Results for "${query}"`}</h1>

{#if failure}
  <Failure {failure} />
{:else if shown?.cards.length === 0}
  <p class="muted" role="status">No titles match "{shown.query}".</p>
{:else if shown}
  <ul class="poster-grid">
    {#each shown.cards as card (card.id)}
      <li><PosterCard {card} /></li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    margin: 0 0 20px;
    overflow-wrap: anywhere;
  }
</style>
