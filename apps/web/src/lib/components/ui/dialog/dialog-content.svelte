<script lang="ts">
import XIcon from "@lucide/svelte/icons/x";
import { Dialog as DialogPrimitive } from "bits-ui";
import type { ComponentProps, Snippet } from "svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.ts";
import DialogPortal from "./dialog-portal.svelte";
import * as Dialog from "./index.js";

let {
  ref = $bindable(null),
  class: className,
  portalProps,
  children,
  showCloseButton = true,
  ...restProps
}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
  children: Snippet;
  showCloseButton?: boolean;
} = $props();
</script>

<DialogPortal {...portalProps}>
  <Dialog.Overlay />
  <DialogPrimitive.Content
    bind:ref
    data-slot="dialog-content"
    class={cn(
      "outline-none fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-raised p-6 text-label shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-96 data-[state=open]:duration-(--duration-fast) data-[state=open]:ease-smooth-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-96 data-[state=closed]:duration-(--duration-quick)",
      className
    )}
    {...restProps}
  >
    {@render children?.()}
    {#if showCloseButton}
      <DialogPrimitive.Close data-slot="dialog-close">
        {#snippet child({ props })}
          <Button variant="ghost" class="absolute top-2 right-2" size="icon-sm" {...props}>
            <XIcon  />
            <span class="sr-only">Close</span>
          </Button>
        {/snippet}
      </DialogPrimitive.Close>
    {/if}
  </DialogPrimitive.Content>
</DialogPortal>
