<script lang="ts">
import { Label as LabelPrimitive } from "bits-ui";
import { cn } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  children,
  ...restProps
}: LabelPrimitive.RootProps = $props();
</script>

<LabelPrimitive.Root
  bind:ref
  data-slot="label"
  class={cn("text-subheadline font-medium text-label", className)}
  {...restProps}
>
  {@render children?.()}
</LabelPrimitive.Root>
