<script lang="ts">
import LogOutIcon from "@lucide/svelte/icons/log-out";
import type { Snippet } from "svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { signOut } from "$lib/auth.ts";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.ts";
import { readFailure } from "$lib/errors.ts";
import { initials } from "$lib/shell.ts";

/** The account dropdown: the caller styles the trigger, the menu offers sign out. */
const {
  side,
  align,
  trigger,
  user,
}: {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  trigger: Snippet<[Record<string, unknown>, string]>;
  user: { displayName: string; username: string };
} = $props();
const monogram = $derived(initials(user.displayName || user.username));

let signingOut = $state(false);
async function logout() {
  signingOut = true;
  try {
    await signOut();
    await goto("/login");
  } catch (error) {
    const read = readFailure(error);
    if (read.code === "UNAUTHORIZED") await goto("/login");
    else toast.error("Couldn't sign out", { description: read.message });
  } finally {
    signingOut = false;
  }
}
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      {@render trigger(props, monogram)}
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content {side} {align}>
    <DropdownMenu.Label
      >{user.displayName} · @{user.username}</DropdownMenu.Label
    >
    <DropdownMenu.Separator />
    <DropdownMenu.Item onclick={logout} disabled={signingOut}>
      <LogOutIcon /> Sign out
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
