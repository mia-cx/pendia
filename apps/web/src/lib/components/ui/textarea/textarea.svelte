<script lang="ts">
import type { HTMLTextareaAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  value = $bindable(),
  class: className,
  "data-slot": dataSlot = "textarea",
  ...restProps
}: WithElementRef<HTMLTextareaAttributes> = $props();
</script>

<textarea
  bind:this={ref}
  data-slot={dataSlot}
  class={cn(
    "flex min-h-24 h-auto w-full min-w-0 resize-y rounded-md border-0 bg-fill px-3 py-2 text-body text-label transition-colors lg:text-subheadline placeholder:text-label-secondary contrast-more:border contrast-more:border-input aria-invalid:border aria-invalid:border-destructive disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
    className
  )}
  bind:value
  {...restProps}
></textarea>
