<script lang="ts">
import { Slider as SliderPrimitive } from "bits-ui";
import type { Snippet } from "svelte";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  value = $bindable(),
  orientation = "horizontal",
  variant = "default",
  track,
  valueText,
  class: className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  thumbLabels,
  ...restProps
}: WithoutChildrenOrChild<SliderPrimitive.RootProps> & {
  // Per-thumb names for multi-value sliders, falling back to aria-label.
  thumbLabels?: readonly string[];
  /** "media" is the player's white-on-picture scrubber and volume slider. */
  variant?: "default" | "media";
  /** Rendered inside the track before the Range, for buffered ranges. */
  track?: Snippet;
  /** The value the thumb announces, like "12:34 of 1:45:00". */
  valueText?: string;
} = $props();

const media = $derived(variant === "media");
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
  bind:ref
  bind:value={value as never}
  data-slot="slider"
  {orientation}
  class={cn(
    "group/slider relative flex w-full touch-none items-center select-none data-disabled:opacity-45 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col data-[orientation=vertical]:px-4 data-[orientation=vertical]:py-0",
    media ? "py-2.5 pointer-coarse:py-4" : "py-4 pointer-coarse:py-5",
    className
  )}
  {...restProps}
>
  {#snippet children({ thumbItems })}
    <span
      data-slot="slider-track"
      data-orientation={orientation}
      class={cn(
        "relative grow rounded-full data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5",
        media
          ? "overflow-hidden bg-white/22 transition-[height] duration-(--duration-quick) data-[orientation=horizontal]:h-1 group-hover/slider:data-[orientation=horizontal]:h-1.5 group-has-[[data-active]]/slider:data-[orientation=horizontal]:h-1.5"
          : "overflow-visible bg-fill-strong data-[orientation=horizontal]:h-1.5"
      )}
    >
      {@render track?.()}
      <SliderPrimitive.Range
        data-slot="slider-range"
        class={cn(
          "absolute select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
          media ? "bg-white" : "bg-tint"
        )}
      />
    </span>
    {#each thumbItems as thumb (thumb.index)}
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        index={thumb.index}
        aria-label={thumbLabels?.[thumb.index] ?? ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-valuetext={valueText}
        class={media
          ? "relative block size-3.5 shrink-0 select-none rounded-full bg-white opacity-0 scale-50 shadow-float transition-[opacity,scale] duration-(--duration-quick) group-hover/slider:opacity-100 group-hover/slider:scale-100 focus-visible:opacity-100 focus-visible:scale-100 data-active:opacity-100 data-active:scale-100 disabled:pointer-events-none disabled:opacity-45"
          : "relative block size-5 shrink-0 select-none rounded-full border border-separator bg-white shadow-float transition-transform duration-(--duration-quick) motion-safe:data-active:scale-110 disabled:pointer-events-none disabled:opacity-45"}
      />
    {/each}
  {/snippet}
</SliderPrimitive.Root>
