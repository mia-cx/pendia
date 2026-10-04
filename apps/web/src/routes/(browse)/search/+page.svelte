<script lang="ts">
import SearchIcon from "@lucide/svelte/icons/search";
import { onDestroy, onMount } from "svelte";
import { afterNavigate, beforeNavigate, goto } from "$app/navigation";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import type { ItemCard } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import PosterGrid from "$lib/components/PosterGrid.svelte";
import { Input } from "$lib/components/ui/input/index.ts";
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

const searchDelayMs = 250;
let field = $state("");
let timer: ReturnType<typeof setTimeout> | undefined;

// A link, back or forward wins over a search still waiting to fire.
beforeNavigate(({ type }) => {
  if (type !== "goto") clearTimeout(timer);
});
onDestroy(() => clearTimeout(timer));

// The field follows the URL on back, forward and links, but never mid-typing.
afterNavigate(({ type }) => {
  if (type === "goto") return;
  field = page.url.searchParams.get("q") ?? "";
});

onMount(() => {
  field = page.url.searchParams.get("q") ?? "";
  if (matchMedia("(pointer: fine)").matches)
    document.getElementById("search-field")?.focus();
});

function search() {
  clearTimeout(timer);
  const target =
    field.trim() === ""
      ? "/search"
      : `/search?q=${encodeURIComponent(field.trim())}`;
  void goto(target, {
    replaceState: page.url.pathname === "/search",
    keepFocus: true,
    noScroll: true,
  });
}

function typed() {
  clearTimeout(timer);
  timer = setTimeout(search, searchDelayMs);
}

function submit(event: SubmitEvent) {
  event.preventDefault();
  search();
}
</script>

<svelte:head>
  <title>{query === "" ? "Search" : `${query} · Search`} · Pendia</title>
</svelte:head>

<div class="pt-4 lg:pt-8">
  <h1 class="mb-5 pr-14 text-large-title lg:pr-0">Search</h1>

  <form role="search" onsubmit={submit} class="relative mb-6 max-w-xl">
    <label class="sr-only" for="search-field">Search movies and shows</label>
    <SearchIcon
      class="pointer-events-none absolute top-1/2 left-3.5 size-4.5 -translate-y-1/2 text-label-secondary"
    />
    <Input
      id="search-field"
      type="search"
      placeholder="Movies and shows"
      autocomplete="off"
      class="h-11 rounded-lg pl-10"
      bind:value={field}
      oninput={typed}
    />
  </form>

  {#if failure}
    <Failure {failure} />
  {:else if shown?.cards.length === 0}
    <p class="text-subheadline text-label-secondary" role="status">
      No titles match “{shown.query}”.
    </p>
  {:else if shown}
    <PosterGrid>
      {#each shown.cards as card (card.id)}
        <li><PosterCard {card} /></li>
      {/each}
    </PosterGrid>
  {/if}
</div>
