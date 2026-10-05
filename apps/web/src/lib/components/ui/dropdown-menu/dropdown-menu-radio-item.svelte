<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import { cn, type WithoutChild } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  children: childrenProp,
  closeOnSelect = false,
  ...restProps
}: WithoutChild<DropdownMenuPrimitive.RadioItemProps> = $props();
</script>

<DropdownMenuPrimitive.RadioItem
  bind:ref
  {closeOnSelect}
  data-slot="dropdown-menu-radio-item"
  class={cn(
    "outline-none relative flex cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-subheadline data-highlighted:bg-fill-strong data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-label-secondary pl-7",
    className
  )}
  {...restProps}
>
  {#snippet children({ checked })}
    <span
      class="absolute left-2 flex size-4 items-center justify-center pointer-events-none"
      data-slot="dropdown-menu-radio-item-indicator"
    >
      {#if checked}
        <CheckIcon  />
      {/if}
    </span>
    {@render childrenProp?.({ checked })}
  {/snippet}
</DropdownMenuPrimitive.RadioItem>
