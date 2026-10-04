<script lang="ts">
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import { cn } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  ...restProps
}: DropdownMenuPrimitive.SeparatorProps = $props();
</script>

<DropdownMenuPrimitive.Separator
  bind:ref
  data-slot="dropdown-menu-separator"
  class={cn("mx-2.5 my-1.5 h-px bg-separator", className)}
  {...restProps}
/>
