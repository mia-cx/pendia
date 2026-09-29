<script lang="ts">
import "$lib/admin.css";
</script>

<svelte:head>
  <title>Pendia</title>
</svelte:head>

<main>
  <div class="failure" role="alert">
    <h2>Something went wrong</h2>
    <p>Pendia could not load this screen.</p>
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
