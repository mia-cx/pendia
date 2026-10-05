<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils.ts";

/** A label/control pair inside a form panel; `inline` keeps them on one row. */
const {
  label,
  for: htmlFor,
  hint,
  inline = false,
  children,
}: {
  label: string;
  for?: string;
  hint?: string;
  inline?: boolean;
  children: Snippet;
} = $props();
</script>

<div
  class={cn(
    "relative min-h-12 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden",
    inline
      ? "flex items-center justify-between gap-4 @lg:grid @lg:grid-cols-[12rem_minmax(0,1fr)] @lg:gap-4"
      : "flex flex-col justify-center gap-1.5 @lg:grid @lg:grid-cols-[12rem_minmax(0,1fr)] @lg:items-center @lg:gap-4"
  )}
>
  {#if htmlFor}
    <label for={htmlFor} class="text-subheadline text-label">{label}</label>
  {:else}
    <span class="text-subheadline text-label">{label}</span>
  {/if}
  <div class={cn("min-w-0", inline && "flex shrink-0 items-center gap-3")}>
    {@render children()}
    {#if hint}
      <p class="mt-1 text-footnote text-label-secondary">{hint}</p>
    {/if}
  </div>
</div>
