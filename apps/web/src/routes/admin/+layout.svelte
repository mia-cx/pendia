<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import ChevronUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
import { onNavigate } from "$app/navigation";
import { navDirection } from "$lib/admin.ts";
import AccountMenu from "$lib/components/AccountMenu.svelte";
import AdminNav from "$lib/components/admin/AdminNav.svelte";
import TabBar from "$lib/components/TabBar.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import type { LayoutProps } from "./$types";

const { data, children }: LayoutProps = $props();

function skipToContent(event: MouseEvent) {
  event.preventDefault();
  document.getElementById("content")?.focus();
}

onNavigate((nav) => {
  if (!document.startViewTransition) return;
  // Query-only changes (typing, sorting, filtering) never flicker.
  if (nav.to?.url.pathname === nav.from?.url.pathname) return;
  const direction = navDirection(
    nav.from?.url.pathname ?? "",
    nav.to?.url.pathname ?? "",
  );
  return new Promise<void>((resolve) => {
    const transition = document.startViewTransition(async () => {
      resolve();
      await nav.complete;
    });
    if (direction === null) return;
    document.documentElement.dataset.adminNav = direction;
    transition.finished.finally(() => {
      delete document.documentElement.dataset.adminNav;
    });
  });
});
</script>

<svelte:head>
  <title>Pendia admin</title>
</svelte:head>

<Tooltip.Provider>
<div class="shell">
  <a
    href="#content"
    class="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-60 focus-visible:inline-flex focus-visible:h-10 focus-visible:items-center focus-visible:rounded-full focus-visible:bg-label focus-visible:px-4 focus-visible:text-subheadline focus-visible:font-semibold focus-visible:text-background"
    onclick={skipToContent}>Skip to content</a
  >

  <aside
    class="fixed inset-y-(--sidebar-inset) left-(--sidebar-inset) z-40 hidden w-(--sidebar-width) flex-col material rounded-2xl p-3 shadow-float lg:flex"
  >
    <div class="flex h-10 shrink-0 items-center px-2">
      <a href="/" class="flex items-center gap-0.5 text-tint text-subheadline">
        <ChevronLeftIcon class="size-4.5" />
        Home
      </a>
    </div>

    <div class="mt-4 min-h-0 flex-1 overflow-y-auto">
      <AdminNav variant="sidebar" />
    </div>

    <hr class="my-2 h-px border-0 bg-separator" />

    <AccountMenu side="top" align="start" user={data.me.user}>
      {#snippet trigger(props, monogram)}
        <button
          {...props}
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 transition-colors duration-(--duration-quick) hover:bg-fill"
        >
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-fill-strong text-footnote font-semibold text-label"
            >{monogram}</span
          >
          <span class="min-w-0 flex-1 text-left">
            <span
              class="block truncate text-subheadline font-semibold text-label"
              >{data.me.user.displayName}</span
            >
            <span class="block truncate text-footnote text-label-secondary"
              >{data.me.user.username}</span
            >
          </span>
          <ChevronUpDownIcon class="size-4 shrink-0 text-label-secondary" />
        </button>
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
  .shell {
    --shell-start: var(--gutter);
  }
  @media (min-width: 64rem) {
    .shell {
      --shell-start: calc(
        var(--sidebar-inset) + var(--sidebar-width) + var(--gutter)
      );
    }
  }

  :global(::view-transition-old(content)),
  :global(::view-transition-new(content)) {
    animation-duration: var(--duration-fast);
  }

  /* Phone pushes and pops like System Settings; the sidebar and tab bar hold still. */
  @media (max-width: 63.999rem) and (prefers-reduced-motion: no-preference) {
    :global(html[data-admin-nav="push"]::view-transition-old(content)) {
      animation: admin-pop-out var(--duration-medium) var(--ease-smooth-out)
        both;
    }
    :global(html[data-admin-nav="push"]::view-transition-new(content)) {
      animation: admin-push-in var(--duration-medium) var(--ease-smooth-out)
        both;
    }
    :global(html[data-admin-nav="pop"]::view-transition-old(content)) {
      animation: admin-push-out var(--duration-medium) var(--ease-smooth-out)
        both;
      z-index: 1;
    }
    :global(html[data-admin-nav="pop"]::view-transition-new(content)) {
      animation: admin-pop-in var(--duration-medium) var(--ease-smooth-out)
        both;
    }
  }

  @keyframes -global-admin-push-in {
    from {
      transform: translateX(100%);
    }
  }
  @keyframes -global-admin-pop-out {
    to {
      transform: translateX(-30%);
      opacity: 0.6;
    }
  }
  @keyframes -global-admin-push-out {
    to {
      transform: translateX(100%);
    }
  }
  @keyframes -global-admin-pop-in {
    from {
      transform: translateX(-30%);
      opacity: 0.6;
    }
  }
</style>
