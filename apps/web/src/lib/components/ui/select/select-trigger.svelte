<script lang="ts">
import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
import { Select as SelectPrimitive } from "bits-ui";
import { cn, type WithoutChild } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  children,
  size = "default",
  ...restProps
}: WithoutChild<SelectPrimitive.TriggerProps> & {
  size?: "sm" | "default";
} = $props();
</script>

<SelectPrimitive.Trigger
  bind:ref
  data-slot="select-trigger"
  data-size={size}
  class={cn(
    "flex w-fit items-center justify-between gap-2 rounded-md bg-fill px-3 text-label whitespace-nowrap transition-colors select-none hover:bg-fill-strong data-placeholder:text-label-secondary aria-invalid:border aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-45 data-[size=default]:h-10 data-[size=sm]:h-8 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:text-subheadline *:data-[slot=select-value]:font-medium [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    className
  )}
  {...restProps}
>
  {@render children?.()}
  <ChevronsUpDownIcon class="size-4 text-label-secondary pointer-events-none" />
</SelectPrimitive.Trigger>
