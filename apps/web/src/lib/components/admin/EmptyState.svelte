<script lang="ts">
import type { Component, Snippet } from "svelte";

/** A panel for an empty group: a circled icon, a headline and an optional action. */
const {
  icon: Icon,
  title,
  children,
}: {
  icon: Component;
  title: string;
  children?: Snippet;
} = $props();
</script>

<div class="flex flex-col items-center gap-3 px-4 py-10 text-center">
  <span
    class="flex size-12 items-center justify-center rounded-full bg-fill text-label-secondary"
  >
    <Icon class="size-6" aria-hidden="true" />
  </span>
  <p class="text-headline">{title}</p>
  {@render children?.()}
</div>
