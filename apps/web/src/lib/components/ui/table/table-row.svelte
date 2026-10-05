<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";
import { cn, type WithElementRef } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  children,
  ...restProps
}: WithElementRef<HTMLAttributes<HTMLTableRowElement>> = $props();
</script>

<tr
  bind:this={ref}
  data-slot="table-row"
  class={cn("border-b border-separator transition-colors hover:bg-fill data-[state=selected]:bg-fill", className)}
  {...restProps}
>
  {@render children?.()}
</tr>
