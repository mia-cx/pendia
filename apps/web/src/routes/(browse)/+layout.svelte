<script lang="ts">
import { onDestroy } from "svelte";
import { afterNavigate, beforeNavigate, goto } from "$app/navigation";
import { page } from "$app/state";
import SignOut from "$lib/components/SignOut.svelte";
import type { LayoutProps } from "./$types";

const { data, children }: LayoutProps = $props();

const sections = [
  { href: "/", label: "Home" },
  { href: "/movies", label: "Movies" },
  { href: "/shows", label: "Shows" },
];

const searchDelayMs = 250;

let query = $state("");
let timer: ReturnType<typeof setTimeout> | undefined;

const current = (href: string) =>
  href === "/"
    ? page.url.pathname === "/"
    : page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);

// A link, back or forward wins over a search still waiting to fire.
beforeNavigate(({ type }) => {
  if (type !== "goto") clearTimeout(timer);
});
onDestroy(() => clearTimeout(timer));

// The field follows the URL on back, forward and links, but never mid-typing.
afterNavigate(({ type }) => {
  if (type === "goto") return;
  query =
    page.url.pathname === "/search"
      ? (page.url.searchParams.get("q") ?? "")
      : "";
});

function search() {
  clearTimeout(timer);
  const target =
    query.trim() === ""
      ? "/search"
      : `/search?q=${encodeURIComponent(query.trim())}`;
  void goto(target, {
    replaceState: page.url.pathname === "/search",
    keepFocus: true,
    noScroll: true,
  });
}

function typed() {
  clearTimeout(timer);
  timer = setTimeout(search, searchDelayMs);
}

function submit(event: SubmitEvent) {
  event.preventDefault();
  search();
}
</script>

<div class="legacy">
<header>
  <a class="brand" href="/">Pendia</a>
  <nav aria-label="Library">
    {#each sections as section (section.href)}
      <a
        href={section.href}
        aria-current={current(section.href) ? "page" : undefined}
        >{section.label}</a
      >
    {/each}
  </nav>
  <form role="search" onsubmit={submit}>
    <label class="sr-only" for="search">Search titles</label>
    <input
      id="search"
      type="search"
      placeholder="Search"
      autocomplete="off"
      bind:value={query}
      oninput={typed}
    />
  </form>
  <div class="account">
    {#if data.me.admin}
      <a href="/admin">Admin</a>
    {/if}
    <SignOut />
  </div>
</header>

<main>
  {@render children()}
</main>
</div>

<style>
  header {
    display: grid;
    grid-template-columns: auto 1fr minmax(160px, 280px) auto;
    align-items: center;
    gap: 12px 32px;
    padding: 12px var(--gutter);
    border-bottom: 1px solid var(--line);
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
    gap: 20px;
  }

  nav a,
  .account a {
    padding: 6px 0;
    color: var(--muted);
    text-decoration: none;
  }

  nav a:hover,
  .account a:hover {
    color: var(--ink);
  }

  nav a[aria-current="page"] {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--signal);
    text-decoration-thickness: 2px;
    text-underline-offset: 8px;
  }

  input {
    width: 100%;
    min-height: 36px;
  }

  .account {
    display: flex;
    align-items: center;
    gap: 16px;
    white-space: nowrap;
  }

  main {
    padding: 24px var(--gutter) 64px;
  }

  @media (max-width: 720px) {
    header {
      grid-template-columns: 1fr auto;
    }

    nav {
      grid-column: 1 / -1;
      grid-row: 2;
    }

    form {
      grid-column: 1 / -1;
      grid-row: 3;
    }

    .account {
      grid-row: 1;
      grid-column: 2;
    }
  }
</style>
