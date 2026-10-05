<script lang="ts">
import type { Snippet } from "svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.ts";

/** An alert dialog that names its destructive action and runs a callback. */
let {
  title,
  description,
  action,
  onconfirm,
  onclosed,
  open = $bindable(false),
  trigger,
}: {
  title: string;
  description: string;
  action: string;
  onconfirm: () => void | Promise<void>;
  onclosed?: () => void;
  open?: boolean;
  trigger?: Snippet<[Record<string, unknown>]>;
} = $props();

async function confirm() {
  await onconfirm();
  open = false;
}
</script>

<AlertDialog.Root
  bind:open
  onOpenChangeComplete={(open) => {
    if (!open) onclosed?.();
  }}
>
  {#if trigger}
    <AlertDialog.Trigger>
      {#snippet child({ props })}
        {@render trigger(props)}
      {/snippet}
    </AlertDialog.Trigger>
  {/if}
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description>{description}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action variant="destructive" onclick={confirm}>
        {action}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
