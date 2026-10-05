<script lang="ts">
import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
import { goto } from "$app/navigation";
import { type BrowseCard, cardLabel, itemHref } from "$lib/browse.ts";
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
// The pages a card can open: its own, then its Show's.
const items = $derived.by(() => {
  const list: { label: string; href: string }[] = [];
  if (href !== null) list.push({ label: `Go to ${card.kind}`, href });
  if ((card.kind === "episode" || card.kind === "season") && showHref !== null)
    list.push({ label: "Go to show", href: showHref });
  return list;
});
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
    {#each items as item (item.href)}
      <DropdownMenu.Item onSelect={() => goto(item.href)}>
        {item.label}
      </DropdownMenu.Item>
    {/each}
    {#if progress !== null}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={() => goto(`/play/${card.id}?t=0`)}>
        Play from start
      </DropdownMenu.Item>
    {/if}
    <!-- #106 adds Mark as watched, the watchlist and Share here. -->
  </DropdownMenu.Content>
</DropdownMenu.Root>
