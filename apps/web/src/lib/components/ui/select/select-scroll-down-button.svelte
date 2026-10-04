<script lang="ts">
import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
import { Select as SelectPrimitive } from "bits-ui";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: WithoutChildrenOrChild<SelectPrimitive.ScrollDownButtonProps> = $props();
</script>

<SelectPrimitive.ScrollDownButton
  bind:ref
  data-slot="select-scroll-down-button"
  class={cn("z-10 flex cursor-default items-center justify-center py-1 text-label-secondary [&_svg:not([class*='size-'])]:size-4", className)}
  {...restProps}
>
  <ChevronDownIcon  />
</SelectPrimitive.ScrollDownButton>
