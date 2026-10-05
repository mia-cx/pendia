<script lang="ts">
import type { Separator as SeparatorPrimitive } from "bits-ui";
import { Separator } from "$lib/components/ui/separator/index.js";
import { cn } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: SeparatorPrimitive.RootProps = $props();
</script>

<Separator
  bind:ref
  data-slot="select-separator"
  class={cn("mx-2.5 my-1.5 h-px bg-separator pointer-events-none", className)}
  {...restProps}
/>
