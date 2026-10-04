<script lang="ts">
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import { resource } from "$lib/resource.svelte.ts";

const home = resource(() => client.shelves.home());
</script>

<svelte:head>
  <title>Pendia</title>
</svelte:head>

<h1 class="sr-only">Home</h1>

{#if home.failure}
  <Failure failure={home.failure} />
{:else if home.data?.length === 0}
  <div class="empty">
    <h2>Nothing to watch yet</h2>
    {#if page.data.me.admin}
      <p><a href="/admin/libraries">Add a library</a> to fill Home.</p>
    {:else}
      <p class="muted">Titles appear here once an admin adds a library.</p>
    {/if}
  </div>
{:else if home.data}
  {#each home.data as shelf (shelf.id)}
    <section aria-labelledby="shelf-{shelf.id}">
      <h2 id="shelf-{shelf.id}">{shelf.title}</h2>
      <ul class="row">
        {#each shelf.entries as entry (entry.item.id)}
          <li><PosterCard card={entry.item} progress={entry.progress} /></li>
        {/each}
      </ul>
    </section>
  {/each}
{/if}

<style>
  section + section {
    margin-top: 32px;
  }

  h2 {
    margin: 0 0 12px;
  }

  .row {
    display: grid;
    grid-auto-columns: clamp(120px, 28vw, 168px);
    grid-auto-flow: column;
    gap: 16px;
    margin: 0 calc(-1 * var(--gutter));
    padding: 4px var(--gutter) 12px;
    overflow-x: auto;
    list-style: none;
    scroll-padding-inline: var(--gutter);
    scroll-snap-type: x proximity;
  }

  .row li {
    scroll-snap-align: start;
  }

  .empty {
    padding: 48px 0;
  }

  .empty h2 {
    margin-bottom: 4px;
  }

  .empty p {
    margin: 0;
  }
</style>
