<script lang="ts">
import type { Snippet } from "svelte";
import AdminBackLink from "$lib/components/admin/AdminBackLink.svelte";

/** The one section layout every admin page uses: back row, large title, grouped body. */
const {
  title,
  parent,
  actions,
  children,
}: {
  title: string;
  parent?: { href: string; label: string };
  actions?: Snippet;
  children?: Snippet;
} = $props();
</script>

<svelte:head>
  <title>{title} · Pendia admin</title>
</svelte:head>

<div class="mx-auto w-full max-w-3xl">
  {#if parent}
    <div class="pt-4 lg:pt-8">
      <AdminBackLink href={parent.href} label={parent.label} always />
    </div>
  {:else}
    <AdminBackLink href="/admin" label="Settings" />
    <!-- The hidden back row is the phone offset; desktop pads like browse. -->
    <div class="hidden lg:block lg:h-8" aria-hidden="true"></div>
  {/if}
  <div
    class="mb-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
  >
    <h1 class="text-large-title">{title}</h1>
    {#if actions}
      <div class="flex items-center gap-2">{@render actions()}</div>
    {/if}
  </div>
  <div class="flex flex-col gap-8">
    {@render children?.()}
  </div>
</div>
