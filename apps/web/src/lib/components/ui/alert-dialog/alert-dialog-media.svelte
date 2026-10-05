<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  children,
  ...restProps
}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
  bind:this={ref}
  data-slot="alert-dialog-media"
  class={cn("mb-2 inline-flex size-10 items-center justify-center rounded-full bg-tint-fill text-tint *:[svg:not([class*='size-'])]:size-5", className)}
  {...restProps}
>
  {@render children?.()}
</div>
