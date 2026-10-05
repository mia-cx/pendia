<script lang="ts">
import type { Component, Snippet } from "svelte";

/** The centred card the sign in, setup, invite and error screens share. */
let {
  title,
  icon: Icon,
  header,
  children,
  heading = $bindable(),
  card = $bindable(),
}: {
  title: string;
  icon?: Component;
  header?: Snippet;
  children?: Snippet;
  heading?: HTMLHeadingElement;
  card?: HTMLDivElement;
} = $props();
</script>

<main
  class="focus-screen grid min-h-svh justify-items-center bg-background sm:content-center sm:bg-elevated sm:p-6"
>
  <div
    bind:this={card}
    class="flex w-full animate-in flex-col items-center gap-4 px-(--gutter) pt-[16svh] pb-10 duration-(--duration-fast) ease-smooth-out fade-in-0 slide-in-from-bottom-2 sm:w-[min(100%,26rem)] sm:rounded-xl sm:bg-raised sm:px-10 sm:pt-10 sm:pb-10 sm:shadow-float"
  >
    {@render header?.()}
    {#if Icon}
      <Icon class="size-12 text-tint" />
    {/if}
    <h1
      bind:this={heading}
      tabindex="-1"
      class="text-center text-large-title text-label focus-visible:outline-none"
    >
      {title}
    </h1>
    <div class="mt-2 flex w-full flex-col items-center">
      {@render children?.()}
    </div>
  </div>
</main>

<style>
  /* A faint tint wash over the elevated backdrop; phones keep a plain background. */
  @media (min-width: 640px) {
    .focus-screen {
      background-image: radial-gradient(
        ellipse at top,
        var(--tint-fill),
        transparent 60%
      );
    }
  }
  @media (prefers-contrast: more) {
    .focus-screen {
      background-image: none;
    }
  }
</style>
