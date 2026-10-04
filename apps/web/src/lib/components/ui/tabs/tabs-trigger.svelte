<script lang="ts">
import { Tabs as TabsPrimitive } from "bits-ui";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: TabsPrimitive.TriggerProps = $props();
</script>

<TabsPrimitive.Trigger
	bind:ref
	data-slot="tabs-trigger"
	class={cn(
		"relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-[0.5rem] px-3 text-footnote font-semibold whitespace-nowrap text-label-secondary transition-colors group-data-[orientation=vertical]/tabs:w-full hover:text-label data-[state=active]:bg-raised data-[state=active]:text-label data-[state=active]:shadow-sm dark:data-[state=active]:bg-fill-strong disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		"group-data-[variant=line]/tabs-list:bg-transparent",
		className
	)}
	{...restProps}
/>
