<script lang="ts">
import ChevronUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
import PanelLeftIcon from "@lucide/svelte/icons/panel-left";
import { onNavigate } from "$app/navigation";
import { page } from "$app/state";
import AccountMenu from "$lib/components/AccountMenu.svelte";
import { navIcons } from "$lib/components/nav-icons.ts";
import TabBar from "$lib/components/TabBar.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import {
  isCurrent,
  isCurrentSection,
  type NavEntry,
  navigation,
} from "$lib/shell.ts";
import type { LayoutProps } from "./$types";

const { data, children }: LayoutProps = $props();

const entries = $derived(navigation(data.me.admin, data.libraries));
const settings = $derived(entries.find((e) => e.icon === "settings"));

let collapsed = $state(
  typeof document !== "undefined" &&
    document.documentElement.dataset.sidebar === "collapsed",
);

function toggle() {
  collapsed = !collapsed;
  try {
    if (collapsed) localStorage.setItem("thalia.sidebar", "collapsed");
    else localStorage.removeItem("thalia.sidebar");
  } catch {
    // Storage can be blocked; the sidebar simply reverts on the next load.
  }
  if (collapsed) document.documentElement.dataset.sidebar = "collapsed";
  else delete document.documentElement.dataset.sidebar;
}

function skipToContent(event: MouseEvent) {
  event.preventDefault();
  document.getElementById("content")?.focus();
}

onNavigate((nav) => {
  if (!document.startViewTransition) return;
  // Query-only changes (typing, sorting, filtering) never flicker.
  if (nav.to?.url.pathname === nav.from?.url.pathname) return;
  return new Promise<void>((resolve) => {
    document.startViewTransition(async () => {
      resolve();
      await nav.complete;
    });
  });
});
</script>

<svelte:head>
  <title>Thalia</title>
</svelte:head>

{#snippet navRow(entry: NavEntry, children: boolean)}
  {@const Icon = navIcons[entry.icon]}
  {@const current = isCurrentSection(page.url, entry, children && !collapsed)}
  <Tooltip.Root disabled={!collapsed}>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <a
          {...props}
          href={entry.href}
          aria-current={current ? "page" : undefined}
          class="flex items-center gap-3 rounded-md px-2.5 text-subheadline font-medium text-label no-underline transition-colors duration-(--duration-quick) hover:bg-fill"
          class:bg-tint-fill={current}
          class:font-semibold={current}
          class:text-tint={current}
          class:h-9={!collapsed}
          class:size-11={collapsed}
          class:justify-center={collapsed}
          class:px-0={collapsed}
        >
          <Icon
            class="size-4.5 shrink-0 {current
              ? 'text-tint'
              : 'text-label-secondary'}"
          />
          <span class:sr-only={collapsed}>{entry.label}</span>
        </a>
      {/snippet}
    </Tooltip.Trigger>
    {#if collapsed}
      <Tooltip.Content side="right">{entry.label}</Tooltip.Content>
    {/if}
  </Tooltip.Root>
  {#if !collapsed && children}
    <ul class="mt-0.5 flex flex-col gap-0.5">
      {#each entry.children as child (child.href)}
        <li>
          <a
            href={child.href}
            aria-current={isCurrent(page.url, child.href) ? "page" : undefined}
            class="flex h-8 items-center rounded-md ps-10 text-subheadline font-medium text-label no-underline transition-colors duration-(--duration-quick) hover:bg-fill"
            class:bg-tint-fill={isCurrent(page.url, child.href)}
            class:font-semibold={isCurrent(page.url, child.href)}
            class:text-tint={isCurrent(page.url, child.href)}
            >{child.label}</a
          >
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<Tooltip.Provider>
<div class="shell" class:collapsed>
  <a
    href="#content"
    class="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-60 focus-visible:inline-flex focus-visible:h-10 focus-visible:items-center focus-visible:rounded-full focus-visible:bg-label focus-visible:px-4 focus-visible:text-subheadline focus-visible:font-semibold focus-visible:text-background"
    onclick={skipToContent}>Skip to content</a
  >

  <aside
    id="sidebar"
    class="fixed inset-y-(--sidebar-inset) left-(--sidebar-inset) z-40 hidden flex-col material rounded-2xl shadow-float transition-[width] duration-(--duration-fast) ease-smooth-out motion-reduce:transition-none lg:flex"
    style:width={collapsed ? "var(--sidebar-rail)" : "var(--sidebar-width)"}
    class:p-3={!collapsed}
    class:p-2.5={collapsed}
  >
    <div
      class="flex h-10 shrink-0 items-center"
      class:justify-center={collapsed}
      class:justify-between={!collapsed}
      class:px-2={!collapsed}
    >
      {#if !collapsed}
        <a href="/" class="text-title-3 font-bold tracking-tight text-label">Thalia</a>
      {/if}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              onclick={toggle}
              aria-expanded={!collapsed}
              aria-controls="sidebar"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <PanelLeftIcon />
            </Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="right">
          {collapsed ? "Expand sidebar" : "Collapse sidebar"}
        </Tooltip.Content>
      </Tooltip.Root>
    </div>

    <nav aria-label="Main" class="mt-4 min-h-0 flex-1 overflow-y-auto">
      <ul class="flex flex-col gap-0.5">
        {#each entries.filter((e) => e.icon !== "settings") as entry (entry.href)}
          <li>{@render navRow(entry, true)}</li>
        {/each}
      </ul>
    </nav>

    {#if settings}
      <div class="mt-auto">{@render navRow(settings, false)}</div>
    {/if}

    <hr class="my-2 h-px border-0 bg-separator" />

    <AccountMenu
      side={collapsed ? "right" : "top"}
      align="start"
      user={data.me.user}
    >
      {#snippet trigger(props, monogram)}
        <Tooltip.Root disabled={!collapsed}>
          <Tooltip.Trigger>
            {#snippet child({ props: tip })}
              <button
                {...tip}
                {...props}
                onclick={(event: MouseEvent) => {
                  (tip.onclick as ((e: MouseEvent) => void) | undefined)?.(
                    event,
                  );
                  (props.onclick as ((e: MouseEvent) => void) | undefined)?.(
                    event,
                  );
                }}
                type="button"
                class="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 transition-colors duration-(--duration-quick) hover:bg-fill"
                class:justify-center={collapsed}
                class:px-0={collapsed}
              >
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-full bg-fill-strong text-footnote font-semibold text-label"
                  >{monogram}</span
                >
                <span class="min-w-0 flex-1 text-left" class:sr-only={collapsed}>
                  <span class="block truncate text-subheadline font-semibold text-label"
                    >{data.me.user.displayName}</span
                  >
                  <span class="block truncate text-footnote text-label-secondary"
                    >{data.me.user.username}</span
                  >
                </span>
                {#if !collapsed}
                  <ChevronUpDownIcon class="size-4 shrink-0 text-label-secondary" />
                {/if}
              </button>
            {/snippet}
          </Tooltip.Trigger>
          {#if collapsed}
            <Tooltip.Content side="right">{data.me.user.displayName}</Tooltip.Content>
          {/if}
        </Tooltip.Root>
      {/snippet}
    </AccountMenu>
  </aside>

  <TabBar admin={data.me.admin} />

  <div class="relative">
    <div class="absolute top-3 right-(--gutter) z-30 lg:hidden">
      <AccountMenu align="end" user={data.me.user}>
        {#snippet trigger(props, monogram)}
          <Button
            {...props}
            variant="glass"
            size="icon"
            aria-label="Account"
            class="rounded-full"
          >
            <span class="text-footnote font-semibold">{monogram}</span>
          </Button>
        {/snippet}
      </AccountMenu>
    </div>

    <main
      id="content"
      tabindex="-1"
      class="min-h-svh ps-(--shell-start) pe-(--gutter) pb-[calc(5rem+env(safe-area-inset-bottom))] outline-none [view-transition-name:content] lg:pb-8"
    >
      {@render children()}
    </main>
  </div>
</div>
</Tooltip.Provider>

<style>
  @property --shell-start {
    syntax: "<length>";
    inherits: true;
    initial-value: 0px;
  }
  .shell {
    --shell-start: var(--gutter);
    transition: --shell-start var(--duration-fast) var(--ease-smooth-out);
  }
  @media (min-width: 64rem) {
    .shell {
      --shell-start: calc(
        var(--sidebar-inset) + var(--sidebar-width) + var(--gutter)
      );
    }
    .shell.collapsed {
      --shell-start: calc(
        var(--sidebar-inset) + var(--sidebar-rail) + var(--gutter)
      );
    }
  }

  :global(::view-transition-old(content)),
  :global(::view-transition-new(content)) {
    animation-duration: var(--duration-fast);
  }
</style>
