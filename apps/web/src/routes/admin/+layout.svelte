<script lang="ts">
import { page } from "$app/state";
import SignOut from "$lib/components/SignOut.svelte";
import type { LayoutProps } from "./$types";

const { data, children }: LayoutProps = $props();

const sections = [
  { href: "/admin/activity", label: "Activity" },
  { href: "/admin/libraries", label: "Libraries" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/groups", label: "Groups" },
  { href: "/admin/plugins", label: "Plugins" },
  { href: "/admin/settings", label: "Settings" },
];
</script>

<svelte:head>
  <title>Pendia admin</title>
</svelte:head>

<header>
  <a class="brand" href="/">Pendia</a>
  <nav aria-label="Admin sections">
    {#each sections as section (section.href)}
      <a
        href={section.href}
        aria-current={page.url.pathname === section.href ||
        page.url.pathname.startsWith(`${section.href}/`)
          ? "page"
          : undefined}>{section.label}</a
      >
    {/each}
  </nav>
  <div class="who">
    <span class="muted">{data.me.user.displayName}</span>
    <SignOut />
  </div>
</header>

<main>
  {@render children()}
</main>

<style>
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 24px;
    padding: 12px 24px;
    border-bottom: 1px solid color-mix(in oklch, var(--ink) 16%, transparent);
  }

  .brand {
    color: var(--ink);
    font-size: 20px;
    font-weight: 750;
    letter-spacing: -0.03em;
    text-decoration: none;
  }

  nav {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  nav a {
    padding: 4px 0;
    color: var(--muted);
    text-decoration: none;
  }

  nav a[aria-current="page"] {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--signal);
    text-underline-offset: 6px;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  main {
    padding: 24px;
  }
</style>
