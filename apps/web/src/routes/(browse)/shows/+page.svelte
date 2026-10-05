<script lang="ts">
import ItemGrid from "$lib/components/ItemGrid.svelte";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Shows · Pendia</title>
</svelte:head>

<ItemGrid
  kind="show"
  heading="Shows"
  emptyText="No shows yet."
  libraries={data.libraries}
/>
