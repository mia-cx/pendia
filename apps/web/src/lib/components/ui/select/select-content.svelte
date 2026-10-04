<script lang="ts">
import { Select as SelectPrimitive } from "bits-ui";
import type { ComponentProps } from "svelte";
import type { WithoutChildrenOrChild } from "$lib/utils.js";
import { cn, type WithoutChild } from "$lib/utils.js";
import SelectPortal from "./select-portal.svelte";
import SelectScrollDownButton from "./select-scroll-down-button.svelte";
import SelectScrollUpButton from "./select-scroll-up-button.svelte";

let {
  ref = $bindable(null),
  class: className,
  sideOffset = 4,
  portalProps,
  children,
  preventScroll = true,
  ...restProps
}: WithoutChild<SelectPrimitive.ContentProps> & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof SelectPortal>>;
} = $props();
</script>

<SelectPortal {...portalProps}>
	<SelectPrimitive.Content
		bind:ref
		{sideOffset}
		{preventScroll}
		data-slot="select-content"
		class={cn(
			"material-thick text-label data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:duration-(--duration-fast) data-[state=open]:ease-smooth-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-99 data-[state=closed]:duration-(--duration-quick) min-w-48 rounded-lg p-1.5 shadow-float relative z-50 max-h-(--bits-select-content-available-height) origin-(--bits-select-content-transform-origin) overflow-x-hidden overflow-y-auto",
			className
		)}
		{...restProps}
	>
		<SelectScrollUpButton />
		<SelectPrimitive.Viewport
			class={cn(
				"h-(--bits-select-anchor-height) w-full min-w-(--bits-select-anchor-width) scroll-my-1"
			)}
		>
			{@render children?.()}
		</SelectPrimitive.Viewport>
		<SelectScrollDownButton />
	</SelectPrimitive.Content>
</SelectPortal>
