<script lang="ts">
import { MediaQuery } from "svelte/reactivity";
import AdminNav from "$lib/components/admin/AdminNav.svelte";
import Overview from "./Overview.svelte";

const desktop = new MediaQuery("min-width: 64rem");
</script>

<svelte:head>
  <title>Settings · Thalia admin</title>
</svelte:head>

{#if desktop.current}
  <Overview />
{:else}
  <div class="mx-auto w-full max-w-3xl">
    <h1 class="mb-6 pt-4 pr-14 text-large-title">Settings</h1>
    <AdminNav variant="list" />
  </div>
{/if}
