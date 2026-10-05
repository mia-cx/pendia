<script lang="ts">
import type { Snippet } from "svelte";
import Failure from "$lib/components/Failure.svelte";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import type { FailureCode } from "$lib/errors.ts";

/** One grouped form panel with a heading, footnote and actions row. */
const {
  title,
  description,
  failure,
  actions,
  onsubmit,
  loading,
  children,
}: {
  title?: string;
  description?: string | Snippet;
  failure?: { code: FailureCode; message: string };
  actions?: Snippet;
  onsubmit?: (event: SubmitEvent) => void;
  loading?: number;
  children?: Snippet;
} = $props();

const headingId = $props.id();
</script>

{#snippet panel()}
  <div
    class="@container rounded-lg bg-elevated contrast-more:ring-1 contrast-more:ring-separator"
  >
    {#if loading}
      {#each { length: loading } as _, i (i)}
        <div
          class="relative flex min-h-13 flex-col justify-center gap-1.5 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
        >
          <Skeleton class="h-4 w-2/5" />
          <Skeleton class="h-3 w-3/5" />
        </div>
      {/each}
    {:else}
      {@render children?.()}
    {/if}
  </div>
{/snippet}

{#snippet footer()}
  {#if failure}
    <div class="mt-3">
      <Failure {failure} />
    </div>
  {/if}
  {#if description || actions}
    <div class="mt-2 flex items-start justify-between gap-4 px-1">
      <div class="text-footnote text-label-secondary">
        {#if typeof description === "string"}
          {description}
        {:else if description}
          {@render description()}
        {/if}
      </div>
      {#if actions}
        <div class="flex shrink-0 items-center gap-2">
          {@render actions()}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#if onsubmit}
  <form
    {onsubmit}
    aria-labelledby={title ? headingId : undefined}
  >
    {#if title}
      <h2 id={headingId} class="mb-2 px-1 text-headline">{title}</h2>
    {/if}
    {@render panel()}
    {@render footer()}
  </form>
{:else}
  <section aria-labelledby={title ? headingId : undefined}>
    {#if title}
      <h2 id={headingId} class="mb-2 px-1 text-headline">{title}</h2>
    {/if}
    {@render panel()}
    {@render footer()}
  </section>
{/if}
