<script lang="ts" module>
export type Side = "top" | "right" | "bottom" | "left";
</script>

<script lang="ts">
  import { Dialog as SheetPrimitive } from "bits-ui";
  import XIcon from '@lucide/svelte/icons/x';
  import { Button } from "$lib/components/ui/button/index.js";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.ts";
  import SheetOverlay from "./sheet-overlay.svelte";
  import SheetPortal from "./sheet-portal.svelte";
  import type { Snippet } from "svelte";
  import type { ComponentProps } from "svelte";

  let {
    ref = $bindable(null),
    class: className,
    side = "right",
    showCloseButton = true,
    portalProps,
    children,
    ...restProps
  }: WithoutChildrenOrChild<SheetPrimitive.ContentProps> & {
    portalProps?: WithoutChildrenOrChild<ComponentProps<typeof SheetPortal>>;
    side?: Side;
    showCloseButton?: boolean;
    children: Snippet;
  } = $props();
</script>

<SheetPortal {...portalProps}>
  <SheetOverlay />
  <SheetPrimitive.Content
    bind:ref
    data-slot="sheet-content"
    data-side={side}
    class={cn(
      "outline-none material-thick text-label fixed z-50 flex flex-col gap-4 shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--duration-medium) data-[state=open]:ease-smooth-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--duration-fast) data-[side=left]:inset-y-2 data-[side=left]:left-2 data-[side=left]:w-[min(24rem,calc(100%-1rem))] data-[side=left]:rounded-xl data-[side=left]:data-[state=open]:slide-in-from-left-full data-[side=left]:data-[state=closed]:slide-out-to-left-full data-[side=right]:inset-y-2 data-[side=right]:right-2 data-[side=right]:w-[min(24rem,calc(100%-1rem))] data-[side=right]:rounded-xl data-[side=right]:data-[state=open]:slide-in-from-right-full data-[side=right]:data-[state=closed]:slide-out-to-right-full data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:w-full data-[side=bottom]:rounded-t-2xl data-[side=bottom]:data-[state=open]:slide-in-from-bottom-full data-[side=bottom]:data-[state=closed]:slide-out-to-bottom-full data-[side=bottom]:pb-[env(safe-area-inset-bottom)] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:w-full data-[side=top]:rounded-b-2xl data-[side=top]:data-[state=open]:slide-in-from-top-full data-[side=top]:data-[state=closed]:slide-out-to-top-full",
      className
    )}
    {...restProps}
  >
    {#if side === "bottom"}
      <div class="mx-auto -mb-3 mt-1 h-1 w-10 shrink-0 rounded-full bg-fill-strong"></div>
    {/if}
    {@render children?.()}
    {#if showCloseButton}
      <SheetPrimitive.Close data-slot="sheet-close">
        {#snippet child({ props })}
          <Button variant="ghost" class="absolute top-3 right-3" size="icon-sm" {...props}>
            <XIcon  />
            <span class="sr-only">Close</span>
          </Button>
        {/snippet}
      </SheetPrimitive.Close>
    {/if}
  </SheetPrimitive.Content>
</SheetPortal>
