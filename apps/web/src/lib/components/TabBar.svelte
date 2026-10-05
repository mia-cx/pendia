<script lang="ts">
import { page } from "$app/state";
import { navIcons } from "$lib/components/nav-icons.ts";
import { isCurrentSection, type NavEntry, navigation } from "$lib/shell.ts";

/** The floating phone tab bar shared by the browse and admin shells. */
const { admin }: { admin: boolean } = $props();

const tabs = $derived(
  ["home", "movies", "shows", "search", "settings"]
    .map((icon) => navigation(admin, []).find((e) => e.icon === icon))
    .filter((e): e is NavEntry => e !== undefined),
);
</script>

<nav
  aria-label="Main"
  class="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 mx-auto grid h-16 max-w-md auto-cols-fr grid-flow-col items-stretch material rounded-full shadow-float lg:hidden"
>
  {#each tabs as tab (tab.href)}
    {@const Icon = navIcons[tab.icon]}
    {@const current = isCurrentSection(page.url, tab, false)}
    <a
      href={tab.href}
      aria-current={current ? "page" : undefined}
      class="relative flex flex-col items-center justify-center gap-0.5 text-label-secondary"
      class:text-tint={current}
    >
      {#if current}
        <span class="absolute inset-x-1 inset-y-1.5 rounded-full bg-tint-fill" aria-hidden="true"></span>
      {/if}
      <Icon class="relative size-6" />
      <span class="relative text-caption-2 font-semibold">{tab.label}</span>
    </a>
  {/each}
</nav>
