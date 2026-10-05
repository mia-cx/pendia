<script lang="ts">
import type { Snippet } from "svelte";
import {
  artworkSrcset,
  artworkUrl,
  backdropWidths,
  posterWidths,
} from "$lib/browse.ts";

const {
  backdropId,
  posterId,
  logoId,
  title,
  heading = "h2",
  eager = false,
  hue = undefined,
  eyebrow = undefined,
  aside = undefined,
  children,
}: {
  backdropId: string | null;
  posterId: string | null;
  logoId: string | null;
  title: string;
  heading?: "h1" | "h2";
  eager?: boolean;
  /** The fallback hue for the no-art layer; unset keeps the neutral gradient. */
  hue?: number;
  /** Content above the title art, such as the owning Show's name. */
  eyebrow?: Snippet;
  /** Content bottom-right from lg, beside the actions row. */
  aside?: Snippet;
  children: Snippet;
} = $props();

let loaded = $state(false);
</script>

<div
  class="dark [color-scheme:dark] relative isolate overflow-hidden bg-black h-[min(78svh,44rem)] lg:h-[min(82svh,max(30rem,56vw))]"
>
  {#if backdropId}
    <img
      src={artworkUrl(backdropId, 1440)}
      srcset={artworkSrcset(backdropId, backdropWidths)}
      sizes="100vw"
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onload={() => (loaded = true)}
      class="absolute inset-0 size-full object-cover transition-opacity duration-(--duration-slow) {loaded
        ? 'opacity-100'
        : 'opacity-0'}"
    />
  {:else if posterId}
    <img
      src={artworkUrl(posterId, 480)}
      srcset={artworkSrcset(posterId, posterWidths)}
      sizes="100vw"
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onload={() => (loaded = true)}
      class="absolute inset-0 size-full object-cover scale-125 blur-3xl brightness-50 saturate-150 transition-opacity duration-(--duration-slow) {loaded
        ? 'opacity-100'
        : 'opacity-0'}"
    />
  {:else if hue !== undefined}
    <div
      class="absolute inset-0 artwork-fallback"
      style:--fallback-hue={hue}
      aria-hidden="true"
    ></div>
  {:else}
    <div
      class="absolute inset-0"
      style="background: radial-gradient(120% 100% at 20% 10%, var(--background-raised), var(--background) 70%)"
      aria-hidden="true"
    ></div>
  {/if}
  <div
    class="absolute inset-x-0 top-0 h-24 bg-linear-to-b from-black/35 to-transparent contrast-more:from-black/60"
    aria-hidden="true"
  ></div>
  <div
    class="absolute inset-x-0 bottom-0 h-full bg-linear-to-t from-black/85 via-black/45 via-30% to-transparent to-70% contrast-more:from-black contrast-more:via-black/70"
    aria-hidden="true"
  ></div>
  <div
    class="absolute inset-y-0 left-0 hidden w-2/3 bg-linear-to-r from-black/65 to-transparent to-55% lg:block contrast-more:from-black/90"
    aria-hidden="true"
  ></div>

  <div
    class="absolute inset-x-0 bottom-0 ps-(--shell-start) pe-(--gutter) pb-16 lg:pb-20"
  >
    <div class="flex items-end gap-8">
      <div class="flex w-full max-w-[36rem] flex-col gap-3">
        {#if eyebrow}
          {@render eyebrow()}
        {/if}
        <svelte:element this={heading}>
          {#if logoId}
            <span class="flex items-end h-[clamp(4rem,8vw,7rem)]">
              <img
                src={artworkUrl(logoId, 960)}
                alt={title}
                loading={eager ? "eager" : "lazy"}
                class="max-h-full max-w-[min(85%,26rem)] w-auto object-contain object-left-bottom drop-shadow"
              />
            </span>
          {:else}
            <span class="block text-display text-white text-balance"
              >{title}</span
            >
          {/if}
        </svelte:element>
        {@render children()}
      </div>
      {#if aside}
        <div
          class="ms-auto hidden max-w-[22rem] text-right text-subheadline lg:block"
        >
          {@render aside()}
        </div>
      {/if}
    </div>
  </div>
</div>
