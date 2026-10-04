<script lang="ts">
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  inset,
  variant = "default",
  ...restProps
}: DropdownMenuPrimitive.ItemProps & {
  inset?: boolean;
  variant?: "default" | "destructive";
} = $props();
</script>

<DropdownMenuPrimitive.Item
	bind:ref
	data-slot="dropdown-menu-item"
	data-inset={inset}
	data-variant={variant}
	class={cn(
		"group/dropdown-menu-item relative flex cursor-default select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-subheadline data-highlighted:bg-fill-strong data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-label-secondary data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:[&_svg]:text-destructive",
		className
	)}
	{...restProps}
/>
