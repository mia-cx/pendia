<script lang="ts">
import { page } from "$app/state";

const unreachable = $derived(page.error?.code === "UNREACHABLE");
</script>

<svelte:head>
  <title>Pendia</title>
</svelte:head>

<main>
  <div class="failure" role="alert">
    {#if unreachable}
      <h2>Server unreachable</h2>
      <p>Pendia cannot reach its server. Check your connection.</p>
    {:else}
      <h2>Something went wrong</h2>
      <p>Pendia could not load this screen.</p>
    {/if}
  </div>
  <button type="button" onclick={() => location.reload()}>Try again</button>
</main>

<style>
  main {
    display: grid;
    min-height: 100svh;
    align-content: center;
    justify-items: center;
    gap: 16px;
    padding: 32px;
  }
</style>
