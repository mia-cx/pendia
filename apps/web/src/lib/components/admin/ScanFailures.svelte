<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { SvelteSet } from "svelte/reactivity";
import { failurePath, failureReason, type ScanStatus } from "$lib/scan.ts";
import { cn } from "$lib/utils.ts";

/** A scan's failures as rows inside a form panel; each row expands to the full error text. */
const {
  failures,
  withRoot,
}: {
  failures: ScanStatus["failures"];
  /** Leads each file's path with its root's folder name, for libraries with several roots. */
  withRoot: boolean;
} = $props();

const ids = $props.id();
const open = new SvelteSet<string>();

function toggle(id: string) {
  if (open.has(id)) open.delete(id);
  else open.add(id);
}

const rowClass =
  "relative before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator";
const hidden = $derived(failures.total - failures.items.length);
</script>

<ul aria-label="Scan errors">
  {#each failures.items as failure (failure.id)}
    {@const expanded = open.has(failure.id)}
    <li class={rowClass}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="{ids}-detail-{failure.id}"
        onclick={() => toggle(failure.id)}
        class="flex min-h-12 w-full items-start gap-3 px-4 py-2.5 text-start transition-colors hover:bg-fill"
      >
        <span class="min-w-0 flex-1">
          <span class="block text-subheadline text-label [overflow-wrap:anywhere]"
            >{failurePath(failure, withRoot)}</span
          >
          <span class="block text-footnote break-words text-destructive"
            >{failureReason(failure)}</span
          >
        </span>
        <ChevronRightIcon
          class={cn(
            "mt-0.5 size-4 shrink-0 text-label-tertiary transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      <pre
        id="{ids}-detail-{failure.id}"
        hidden={!expanded}
        class="mx-4 mb-2.5 max-h-64 overflow-auto rounded-md bg-fill p-3 font-mono text-footnote whitespace-pre text-label-secondary select-text">{failure.detail}</pre>
    </li>
  {/each}
  {#if hidden > 0}
    <li class={cn(rowClass, "px-4 py-2.5 text-footnote text-label-secondary")}>
      {hidden === 1 ? "1 more error" : `${hidden} more errors`} not shown
    </li>
  {/if}
</ul>
