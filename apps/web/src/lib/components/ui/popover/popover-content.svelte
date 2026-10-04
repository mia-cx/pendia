<script lang="ts">
import { Popover as PopoverPrimitive } from "bits-ui";
import type { ComponentProps } from "svelte";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
import PopoverPortal from "./popover-portal.svelte";

let {
  ref = $bindable(null),
  class: className,
  sideOffset = 4,
  align = "center",
  portalProps,
  ...restProps
}: PopoverPrimitive.ContentProps & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof PopoverPortal>>;
} = $props();
</script>

<PopoverPortal {...portalProps}>
	<PopoverPrimitive.Content
		bind:ref
		data-slot="popover-content"
		{sideOffset}
		{align}
		class={cn(
			"material-thick text-label data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--duration-fast) data-[state=open]:ease-smooth-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--duration-quick) data-[state=open]:zoom-in-97 data-[state=closed]:zoom-out-99 z-50 w-72 rounded-lg p-4 shadow-float origin-(--bits-popover-content-transform-origin)",
			className
		)}
		{...restProps}
	/>
</PopoverPortal>
