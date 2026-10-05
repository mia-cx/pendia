<script lang="ts">
import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
import { goto } from "$app/navigation";
import {
  type BrowseCard,
  cardLabel,
  itemHref,
} from "$lib/browse.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.ts";

const {
  card,
  progress = null,
}: {
  card: BrowseCard;
  progress?: { positionSeconds: number; durationSeconds: number | null } | null;
} = $props();

const href = $derived(itemHref(card));
const showHref = $derived(
  card.kind === "show"
    ? `/shows/${card.id}`
    : (card.show && `/shows/${card.show.id}`) || null,
);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="glass"
        size="icon-sm"
        aria-label="Actions for {cardLabel(card)}"
      >
        <EllipsisIcon />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
    {#if card.kind === "movie" && href}
      <DropdownMenu.Item onclick={() => goto(href)}>
        Go to movie
      </DropdownMenu.Item>
    {:else if card.kind === "episode"}
      {#if href}
        <DropdownMenu.Item onclick={() => goto(href)}>
          Go to episode
        </DropdownMenu.Item>
      {/if}
      {#if showHref}
        <DropdownMenu.Item onclick={() => goto(showHref)}>
          Go to show
        </DropdownMenu.Item>
      {/if}
    {:else if card.kind === "season"}
      {#if href}
        <DropdownMenu.Item onclick={() => goto(href)}>
          Go to season
        </DropdownMenu.Item>
      {/if}
      {#if showHref}
        <DropdownMenu.Item onclick={() => goto(showHref)}>
          Go to show
        </DropdownMenu.Item>
      {/if}
    {:else if card.kind === "show"}
      <DropdownMenu.Item onclick={() => goto(`/shows/${card.id}`)}>
        Go to show
      </DropdownMenu.Item>
    {/if}
    {#if progress !== null}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onclick={() => goto(`/play/${card.id}?t=0`)}>
        Play from start
      </DropdownMenu.Item>
    {/if}
    <!-- #106 adds Mark as watched, the watchlist and Share here. -->
  </DropdownMenu.Content>
</DropdownMenu.Root>
