<script lang="ts" module>
import type { VariantProps } from "tailwind-variants";
import { tv } from "$lib/utils.js";

export const badgeVariants = tv({
  base: "inline-flex h-5.5 w-fit shrink-0 items-center justify-center gap-1 rounded-full px-2 text-caption-1 font-semibold whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3",
  variants: {
    variant: {
      default: "bg-fill-strong text-label",
      tint: "bg-tint-fill text-tint",
      outline: "border border-separator text-label-secondary",
      destructive: "bg-destructive text-destructive-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = "default",
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
	} = $props();
</script>

<svelte:element
	this={href ? "a" : "span"}
	bind:this={ref}
	data-slot="badge"
	{href}
	class={cn(badgeVariants({ variant }), className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
