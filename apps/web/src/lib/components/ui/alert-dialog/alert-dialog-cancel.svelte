<script lang="ts">
import { AlertDialog as AlertDialogPrimitive } from "bits-ui";
import {
  type ButtonSize,
  type ButtonVariant,
  buttonVariants,
} from "$lib/components/ui/button/index.js";
import { cn } from "$lib/utils.ts";

let {
  ref = $bindable(null),
  class: className,
  variant = "secondary",
  size = "default",
  ...restProps
}: AlertDialogPrimitive.CancelProps & {
  variant?: ButtonVariant;
  size?: ButtonSize;
} = $props();
</script>

<AlertDialogPrimitive.Cancel
  bind:ref
  data-slot="alert-dialog-cancel"
  class={cn(buttonVariants({ variant, size }), "", className)}
  {...restProps}
/>
