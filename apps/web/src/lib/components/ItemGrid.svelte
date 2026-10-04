<script lang="ts">
import ArrowDownUpIcon from "@lucide/svelte/icons/arrow-down-up";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import type { ItemCard } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import PosterGrid from "$lib/components/PosterGrid.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import { readFailure } from "$lib/errors.ts";

import type { ShellLibrary } from "$lib/shell.ts";

const {
  kind,
  heading,
  emptyText,
  libraries,
}: {
  kind: "movie" | "show";
  heading: string;
  emptyText: string;
  libraries: readonly ShellLibrary[];
} = $props();

type Sort = "added" | "title";

const sort = $derived<Sort>(
  page.url.searchParams.get("sort") === "title" ? "title" : "added",
);
const libraryId = $derived(page.url.searchParams.get("library"));
const title = $derived(
  libraryId === null
    ? heading
    : (libraries.find((l) => l.id === libraryId)?.name ?? heading),
);

let cards = $state<ItemCard[]>([]);
let cursor = $state<string | null>(null);
let loaded = $state(false);
let loading = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let generation = 0;
let more = $state<HTMLElement | undefined>(undefined);

async function load(order: Sort, library: string | null, after: string | null) {
  const ticket = ++generation;
  loading = true;
  failure = undefined;
  try {
    const result = await client.items.list({
      kind,
      sort: order,
      ...(library === null ? {} : { libraryId: library }),
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
  void load(sort, libraryId, null);
});

function showMore() {
  if (!loading && cursor !== null) void load(sort, libraryId, cursor);
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

function setSort(value: string) {
  const url = new URL(page.url);
  if (value === "title") url.searchParams.set("sort", "title");
  else url.searchParams.delete("sort");
  void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
}
</script>

<div class="mb-5 flex flex-wrap items-baseline justify-between gap-3 pt-4 lg:pt-8">
  <h1 class="w-full pr-14 text-large-title lg:w-auto lg:pr-0">{title}</h1>
  <Select.Root
    type="single"
    value={sort}
    onValueChange={setSort}
  >
    <Select.Trigger aria-label="Sort by" class="ml-auto">
      <ArrowDownUpIcon class="size-4 text-label-secondary" />
      <Select.Value>{sort === "title" ? "Title" : "Recently added"}</Select.Value>
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="added">Recently added</Select.Item>
      <Select.Item value="title">Title</Select.Item>
    </Select.Content>
  </Select.Root>
</div>

{#if loaded && cards.length === 0 && !failure}
  <p class="text-subheadline text-label-secondary">{emptyText}</p>
{/if}

{#if !loaded && !failure}
  <PosterGrid aria-hidden="true">
    {#each { length: 18 } as _}
      <li>
        <Skeleton class="block aspect-[2/3] rounded-poster" />
        <Skeleton class="mt-2 h-5 w-3/4" />
        <Skeleton class="mt-1 h-[1.125rem] w-1/2" />
      </li>
    {/each}
  </PosterGrid>
{/if}

<PosterGrid>
  {#each cards as card (card.id)}
    <li><PosterCard {card} /></li>
  {/each}
</PosterGrid>

{#if failure}
  <Failure {failure} />
{/if}

{#if cursor !== null}
  <div class="mt-8 flex justify-center">
    <Button
      variant="secondary"
      bind:ref={more}
      onclick={showMore}
      disabled={loading}
      aria-busy={loading}>Show more</Button
    >
  </div>
{/if}
