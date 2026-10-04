<script lang="ts">
import { Tooltip as TooltipPrimitive } from "bits-ui";
import type { ComponentProps } from "svelte";
import type { WithoutChildrenOrChild } from "$lib/utils.js";
import { cn } from "$lib/utils.js";
import TooltipPortal from "./tooltip-portal.svelte";

let {
  ref = $bindable(null),
  class: className,
  sideOffset = 0,
  side = "top",
  children,
  arrowClasses,
  portalProps,
  ...restProps
}: TooltipPrimitive.ContentProps & {
  arrowClasses?: string;
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof TooltipPortal>>;
} = $props();
</script>

<TooltipPortal {...portalProps}>
	<TooltipPrimitive.Content
		bind:ref
		data-slot="tooltip-content"
		{sideOffset}
		{side}
		class={cn(
			"z-50 inline-flex w-fit max-w-xs items-center gap-1.5 rounded-sm material-thick px-2 py-1 text-footnote text-label shadow-float origin-(--bits-tooltip-content-transform-origin) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:duration-(--duration-quick)",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
</TooltipPrimitive.Content>
</TooltipPortal>
