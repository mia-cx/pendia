<script lang="ts">
import { Progress as ProgressPrimitive } from "bits-ui";
import { cn } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  value = null,
  max = 100,
  ...restProps
}: ProgressPrimitive.RootProps = $props();

const fraction = $derived(
  value === null ? null : Math.min(1, Math.max(0, value / max)),
);
</script>

<ProgressPrimitive.Root
  bind:ref
  data-slot="progress"
  {value}
  {max}
  class={cn(
    "relative h-1.5 w-full overflow-hidden rounded-full bg-fill",
    className
  )}
  {...restProps}
>
  {#if fraction === null}
    <div
      data-slot="progress-indicator"
      class="progress-indeterminate absolute inset-y-0 left-0 w-[30%] rounded-full bg-tint"
    ></div>
  {:else}
    <div
      data-slot="progress-indicator"
      class="absolute inset-y-0 left-0 rounded-full bg-tint transition-[width] duration-(--duration-slow) ease-smooth-out"
      style:width="{fraction * 100}%"
    ></div>
  {/if}
</ProgressPrimitive.Root>

<style>
  /* A tint segment crossing the track on a loop while the value is unknown. */
  .progress-indeterminate {
    animation: progress-slide 1.1s linear infinite;
  }
  @keyframes progress-slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(334%);
    }
  }
  /* Reduced motion swaps the slide for a static segment pulsing opacity. */
  @media (prefers-reduced-motion: reduce) {
    .progress-indeterminate {
      left: 35%;
      animation: progress-pulse 1.6s ease-in-out infinite;
    }
  }
  @keyframes progress-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
</style>
