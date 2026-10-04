<script lang="ts" module>
import type { VariantProps } from "tailwind-variants";
import { tv } from "$lib/utils.ts";

export const tabsListVariants = tv({
  base: "group/tabs-list inline-flex h-9 w-fit items-center justify-center rounded-md bg-fill p-0.5 text-label-secondary data-[variant=line]:rounded-none data-[variant=line]:bg-transparent group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  variants: {
    variant: {
      default: "",
      line: "gap-1 bg-transparent",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type TabsListVariant = VariantProps<typeof tabsListVariants>["variant"];
</script>

<script lang="ts">
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.ts";

  let {
    ref = $bindable(null),
    variant = "default",
    class: className,
    ...restProps
  }: TabsPrimitive.ListProps & {
    variant?: TabsListVariant;
  } = $props();
</script>

<TabsPrimitive.List
  bind:ref
  data-slot="tabs-list"
  data-variant={variant}
  class={cn(tabsListVariants({ variant }), className)}
  {...restProps}
/>
