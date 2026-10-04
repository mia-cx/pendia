<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  inset,
  children,
  ...restProps
}: DropdownMenuPrimitive.SubTriggerProps & {
  inset?: boolean;
} = $props();
</script>

<DropdownMenuPrimitive.SubTrigger
	bind:ref
	data-slot="dropdown-menu-sub-trigger"
	data-inset={inset}
	class={cn(
		"group/dropdown-menu-item relative flex cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-subheadline data-highlighted:bg-fill-strong data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-label-secondary data-inset:pl-7 data-[state=open]:bg-fill-strong",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ChevronRightIcon class="cn-rtl-flip ml-auto" />
</DropdownMenuPrimitive.SubTrigger>
