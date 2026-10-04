<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import type { ItemCard } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import { readFailure } from "$lib/errors.ts";

const {
  kind,
  heading,
  emptyText,
}: { kind: "movie" | "show"; heading: string; emptyText: string } = $props();

type Sort = "added" | "title";

const sort = $derived<Sort>(
  page.url.searchParams.get("sort") === "title" ? "title" : "added",
);

let cards = $state<ItemCard[]>([]);
let cursor = $state<string | null>(null);
let loaded = $state(false);
let loading = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let generation = 0;
let more = $state<HTMLButtonElement | undefined>(undefined);

async function load(order: Sort, after: string | null) {
  const ticket = ++generation;
  loading = true;
  failure = undefined;
  try {
    const result = await client.items.list({
      kind,
      sort: order,
      ...(after === null ? {} : { cursor: after }),
    });
    if (ticket !== generation) return;
    cards = after === null ? [...result.items] : [...cards, ...result.items];
    cursor = result.cursor;
    loaded = true;
  } catch (error) {
    if (ticket !== generation) return;
    const read = readFailure(error);
    // A caller who may view no library has an empty grid, not an error.
    if (read.code === "FORBIDDEN" && after === null) {
      cards = [];
      cursor = null;
      loaded = true;
    } else {
      failure = read;
    }
  } finally {
    if (ticket === generation) loading = false;
  }
}

$effect(() => {
  loaded = false;
  cards = [];
  cursor = null;
  void load(sort, null);
});

function showMore() {
  if (!loading && cursor !== null) void load(sort, cursor);
}

// The Show more button loads the next page as it scrolls into view.
$effect(() => {
  if (!more) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMore();
    },
    { rootMargin: "400px 0px" },
  );
  observer.observe(more);
  return () => observer.disconnect();
});

function setSort(event: Event & { currentTarget: HTMLSelectElement }) {
  const url = new URL(page.url);
  if (event.currentTarget.value === "title")
    url.searchParams.set("sort", "title");
  else url.searchParams.delete("sort");
  void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
}
</script>

<div class="legacy">
<div class="bar">
  <h1>{heading}</h1>
  <label>
    Sort by
    <select value={sort} onchange={setSort}>
      <option value="added">Recently added</option>
      <option value="title">Title</option>
    </select>
  </label>
</div>

{#if loaded && cards.length === 0 && !failure}
  <p class="muted">{emptyText}</p>
{/if}

<ul class="poster-grid">
  {#each cards as card (card.id)}
    <li><PosterCard {card} /></li>
  {/each}
</ul>

{#if failure}
  <Failure {failure} />
{/if}

{#if cursor !== null}
  <div class="more">
    <button
      type="button"
      bind:this={more}
      onclick={showMore}
      disabled={loading}
      aria-busy={loading}>Show more</button
    >
  </div>
{/if}
</div>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px 24px;
    margin-bottom: 20px;
  }

  h1 {
    margin: 0;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-weight: 400;
  }

  .more {
    display: flex;
    justify-content: center;
    margin-top: 32px;
  }
</style>
