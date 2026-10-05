<script lang="ts">
import { ScrollArea as ScrollAreaPrimitive } from "bits-ui";
import { cn, type WithoutChild } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  orientation = "vertical",
  children,
  ...restProps
}: WithoutChild<ScrollAreaPrimitive.ScrollbarProps> = $props();
</script>

<ScrollAreaPrimitive.Scrollbar
  bind:ref
  data-slot="scroll-area-scrollbar"
  data-orientation={orientation}
  {orientation}
  class={cn(
    "flex touch-none p-0.5 select-none transition-opacity data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2",
    className
  )}
  {...restProps}
>
  {@render children?.()}
  <ScrollAreaPrimitive.Thumb
    data-slot="scroll-area-thumb"
    class="relative flex-1 rounded-full bg-label/22"
  />
</ScrollAreaPrimitive.Scrollbar>
