<script lang="ts">
import ActivityIcon from "@lucide/svelte/icons/activity";
import GaugeIcon from "@lucide/svelte/icons/gauge";
import LibraryIcon from "@lucide/svelte/icons/library";
import PuzzleIcon from "@lucide/svelte/icons/puzzle";
import SearchIcon from "@lucide/svelte/icons/search";
import SettingsIcon from "@lucide/svelte/icons/settings";
import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
import UsersIcon from "@lucide/svelte/icons/users";
import type { Component } from "svelte";
import { page } from "$app/state";
import {
  type AdminIcon,
  type AdminSection,
  adminSectionGroups,
  currentSection,
  matchSections,
} from "$lib/admin.ts";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Input } from "$lib/components/ui/input/index.ts";

/** The admin section nav: sidebar rows on desktop, grouped list rows on phone. */
let {
  variant,
  query = $bindable(""),
}: { variant: "sidebar" | "list"; query?: string } = $props();

const icons = {
  gauge: GaugeIcon,
  activity: ActivityIcon,
  library: LibraryIcon,
  users: UsersIcon,
  "shield-check": ShieldCheckIcon,
  puzzle: PuzzleIcon,
  settings: SettingsIcon,
} satisfies Record<AdminIcon, Component>;

const current = $derived(currentSection(page.url));
const searching = $derived(query.trim() !== "");
const matched = $derived(matchSections(query));
const groups = $derived(searching ? [] : adminSectionGroups);
</script>

<div class="relative">
  <SearchIcon
    class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-label-secondary"
  />
  <Input
    type="search"
    bind:value={query}
    placeholder="Search"
    aria-label="Search settings"
    class="ps-9"
  />
</div>

{#if matched.length === 0}
  <p class="mt-4 px-1 text-subheadline text-label-secondary">
    No results for “{query.trim()}”
  </p>
{:else if variant === "sidebar"}
  <nav aria-label="Settings" class="mt-3">
    {#if searching}
      <ul class="flex flex-col gap-0.5">
        {#each matched as section (section.id)}
          <li>{@render sideRow(section)}</li>
        {/each}
      </ul>
    {:else}
      <div class="flex flex-col gap-4">
        {#each groups as group, i (i)}
          <ul class="flex flex-col gap-0.5">
            {#each group as section (section.id)}
              <li>{@render sideRow(section)}</li>
            {/each}
          </ul>
        {/each}
      </div>
    {/if}
  </nav>
{:else}
  <div class="mt-4 flex flex-col gap-6">
    {#if searching}
      <FormGroup>
        {#each matched as section (section.id)}
          {@render listRow(section)}
        {/each}
      </FormGroup>
    {:else}
      {#each groups as group, i (i)}
        <FormGroup>
          {#each group as section (section.id)}
            {@render listRow(section)}
          {/each}
        </FormGroup>
      {/each}
    {/if}
  </div>
{/if}

{#snippet sideRow(section: AdminSection)}
  {@const Icon = icons[section.icon]}
  {@const active = current === section.id}
  <a
    href={section.href}
    aria-current={active ? "page" : undefined}
    class="flex h-9 items-center gap-3 rounded-md px-2.5 text-subheadline font-medium text-label no-underline transition-colors duration-(--duration-quick) hover:bg-fill"
    class:bg-tint-fill={active}
    class:font-semibold={active}
    class:text-tint={active}
  >
    <Icon
      class="size-4.5 shrink-0 {active ? 'text-tint' : 'text-label-secondary'}"
    />
    {section.label}
  </a>
{/snippet}

{#snippet listRow(section: AdminSection)}
  {@const Icon = icons[section.icon]}
  <ListRow
    title={section.label}
    href={section.href}
    current={current === section.id}
  >
    {#snippet leading()}
      <span
        class="flex size-7 items-center justify-center rounded-sm bg-fill-strong text-label"
      >
        <Icon class="size-4" />
      </span>
    {/snippet}
  </ListRow>
{/snippet}
