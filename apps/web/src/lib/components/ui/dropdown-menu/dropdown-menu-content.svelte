<script lang="ts">
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import type { ComponentProps } from "svelte";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
import DropdownMenuPortal from "./dropdown-menu-portal.svelte";

let {
  ref = $bindable(null),
  sideOffset = 4,
  align = "start",
  portalProps,
  class: className,
  ...restProps
}: DropdownMenuPrimitive.ContentProps & {
  portalProps?: WithoutChildrenOrChild<
    ComponentProps<typeof DropdownMenuPortal>
  >;
} = $props();
</script>

<DropdownMenuPortal {...portalProps}>
	<DropdownMenuPrimitive.Content
		bind:ref
		data-slot="dropdown-menu-content"
		{sideOffset}
		{align}
		class={cn(
			"material-thick text-label data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:duration-(--duration-fast) data-[state=open]:ease-smooth-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-99 data-[state=closed]:duration-(--duration-quick) z-50 min-w-48 rounded-lg p-1.5 shadow-float origin-(--bits-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto max-h-(--bits-dropdown-menu-content-available-height) data-[state=closed]:overflow-hidden",
			className
		)}
		{...restProps}
	/>
</DropdownMenuPortal>
