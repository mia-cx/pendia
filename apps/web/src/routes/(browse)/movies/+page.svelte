<script lang="ts">
import ItemGrid from "$lib/components/ItemGrid.svelte";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Movies · Thalia</title>
</svelte:head>

<ItemGrid
  kind="movie"
  heading="Movies"
  emptyText="No movies yet."
  libraries={data.libraries}
/>
