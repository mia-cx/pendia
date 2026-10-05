<script lang="ts">
import AppWindowIcon from "@lucide/svelte/icons/app-window";
import BellIcon from "@lucide/svelte/icons/bell";
import CalendarClockIcon from "@lucide/svelte/icons/calendar-clock";
import FolderPenIcon from "@lucide/svelte/icons/folder-pen";
import GlobeIcon from "@lucide/svelte/icons/globe";
import HistoryIcon from "@lucide/svelte/icons/history";
import ImageDownIcon from "@lucide/svelte/icons/image-down";
import LibraryIcon from "@lucide/svelte/icons/library";
import Rows3Icon from "@lucide/svelte/icons/rows-3";
import TagIcon from "@lucide/svelte/icons/tag";
import type { Component } from "svelte";
import { type Capability, describeCapabilities } from "$lib/plugins.ts";
import { cn } from "$lib/utils.ts";

/** What a plugin asks for, one row per permission, inside a panel. */
const {
  capabilities,
  network,
}: {
  capabilities: readonly Capability[];
  network: readonly string[];
} = $props();

const icons = {
  "items:read": LibraryIcon,
  "items:write": TagIcon,
  "progress:read": HistoryIcon,
  providers: ImageDownIcon,
  shelves: Rows3Icon,
  events: BellIcon,
  jobs: CalendarClockIcon,
  http: AppWindowIcon,
  network: GlobeIcon,
  files: FolderPenIcon,
} satisfies Record<Capability, Component>;

const lines = $derived(describeCapabilities(capabilities, network));
</script>

<ul
  class="rounded-lg bg-elevated contrast-more:ring-1 contrast-more:ring-separator"
>
  {#each capabilities as capability, i (capability)}
    {@const Icon = icons[capability]}
    <li
      class="relative flex min-h-11 items-center gap-3 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
    >
      <Icon
        class={cn(
          "size-4.5 shrink-0",
          capability === "files" ? "text-destructive" : "text-label-secondary"
        )}
        aria-hidden="true"
      />
      <span class="text-subheadline">{lines[i]}</span>
    </li>
  {:else}
    <li class="relative flex min-h-11 items-center px-4 py-2.5">
      <span class="text-subheadline text-label-secondary"
        >It asks for no permissions.</span
      >
    </li>
  {/each}
</ul>
