<script lang="ts">
import { AlertDialog as AlertDialogPrimitive } from "bits-ui";
import type { ComponentProps } from "svelte";
import {
  cn,
  type WithoutChild,
  type WithoutChildrenOrChild,
} from "$lib/utils.ts";
import AlertDialogOverlay from "./alert-dialog-overlay.svelte";
import AlertDialogPortal from "./alert-dialog-portal.svelte";

let {
  ref = $bindable(null),
  class: className,
  size = "default",
  portalProps,
  ...restProps
}: WithoutChild<AlertDialogPrimitive.ContentProps> & {
  size?: "default" | "sm";
  portalProps?: WithoutChildrenOrChild<
    ComponentProps<typeof AlertDialogPortal>
  >;
} = $props();
</script>

<AlertDialogPortal {...portalProps}>
  <AlertDialogOverlay />
  <AlertDialogPrimitive.Content
    bind:ref
    data-slot="alert-dialog-content"
    data-size={size}
    class={cn(
      "outline-none fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-raised p-6 text-center text-label shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-96 data-[state=open]:duration-(--duration-fast) data-[state=open]:ease-smooth-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-96 data-[state=closed]:duration-(--duration-quick)",
      className
    )}
    {...restProps}
  />
</AlertDialogPortal>
