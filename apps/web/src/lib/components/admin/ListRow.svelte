<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import type { Snippet } from "svelte";
import { cn } from "$lib/utils.ts";

/** A list row inside a panel; with `href` the whole row is a link, with `onclick` a button. */
const {
  title,
  caption,
  href,
  onclick,
  current = false,
  leading,
  children,
}: {
  title: string;
  caption?: string;
  href?: string;
  onclick?: (event: MouseEvent) => void;
  current?: boolean;
  leading?: Snippet;
  children?: Snippet;
} = $props();

const rowClass =
  "relative flex min-h-12 items-center gap-3 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden first:rounded-t-lg last:rounded-b-lg";
</script>

{#snippet inner()}
  {#if leading}
    <span class="shrink-0">{@render leading()}</span>
  {/if}
  <span class="min-w-0 flex-1">
    <span class="block truncate text-subheadline font-medium text-label"
      >{title}</span
    >
    {#if caption}
      <span class="block truncate text-footnote text-label-secondary"
        >{caption}</span
      >
    {/if}
  </span>
  {#if children}
    {@render children()}
  {/if}
  {#if href || onclick}
    <ChevronRightIcon class="size-4 shrink-0 text-label-tertiary" />
  {/if}
{/snippet}

{#if href}
  <a
    {href}
    aria-current={current ? "page" : undefined}
    class={cn(rowClass, "no-underline transition-colors hover:bg-fill")}
  >
    {@render inner()}
  </a>
{:else if onclick}
  <button
    type="button"
    {onclick}
    aria-current={current ? "page" : undefined}
    class={cn(rowClass, "w-full text-start transition-colors hover:bg-fill")}
  >
    {@render inner()}
  </button>
{:else}
  <div class={rowClass} aria-current={current ? "page" : undefined}>
    {@render inner()}
  </div>
{/if}
