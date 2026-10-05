<script lang="ts">
import { Switch as SwitchPrimitive } from "bits-ui";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  checked = $bindable(false),
  size = "default",
  ...restProps
}: WithoutChildrenOrChild<SwitchPrimitive.RootProps> & {
  size?: "sm" | "default";
} = $props();
</script>

<SwitchPrimitive.Root
  bind:ref
  bind:checked
  data-slot="switch"
  data-size={size}
  class={cn(
    "peer group/switch relative inline-flex shrink-0 items-center rounded-full transition-colors data-[state=checked]:bg-tint data-[state=unchecked]:bg-fill-strong data-[state=unchecked]:contrast-more:border data-[state=unchecked]:contrast-more:border-input aria-invalid:border-destructive data-[size=default]:h-6.5 data-[size=default]:w-11 data-[size=sm]:h-5 data-[size=sm]:w-8.5 after:absolute after:-inset-x-3 after:-inset-y-2 data-disabled:cursor-not-allowed data-disabled:opacity-45",
    className
  )}
  {...restProps}
>
  <SwitchPrimitive.Thumb
    data-slot="switch-thumb"
    class={cn(
      "pointer-events-none block rounded-full bg-white shadow-float transition-transform duration-(--duration-fast) ease-spring group-data-[size=default]/switch:mx-0.5 group-data-[size=default]/switch:size-5.5 group-data-[size=sm]/switch:mx-0.5 group-data-[size=sm]/switch:size-4 group-data-[size=default]/switch:data-[state=checked]:translate-x-[calc(100%)] group-data-[size=sm]/switch:data-[state=checked]:translate-x-[calc(100%)] group-data-[size=default]/switch:data-[state=unchecked]:translate-x-0 group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-0",
      "rtl:data-[state=checked]:translate-x-[calc(-100%)]"
    )}
  />
</SwitchPrimitive.Root>
