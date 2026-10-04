<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  inset,
  children,
  ...restProps
}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
  inset?: boolean;
} = $props();
</script>

<div
  bind:this={ref}
  data-slot="dropdown-menu-label"
  data-inset={inset}
  class={cn("px-2.5 pt-1.5 pb-1 text-footnote font-semibold text-label-secondary data-inset:pl-7", className)}
  {...restProps}
>
  {@render children?.()}
</div>
