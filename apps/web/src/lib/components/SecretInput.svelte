<script lang="ts">
import EyeIcon from "@lucide/svelte/icons/eye";
import EyeOffIcon from "@lucide/svelte/icons/eye-off";
import type { ComponentProps } from "svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { cn } from "$lib/utils.ts";

/** A password field with an eye toggle that reveals the value. */
let {
  value = $bindable(),
  ref = $bindable(null),
  class: className,
  ...restProps
}: Omit<ComponentProps<typeof Input>, "type" | "files"> = $props();

let shown = $state(false);
</script>

<div class="relative">
  <Input
    bind:ref
    bind:value
    type={shown ? "text" : "password"}
    class={cn("pe-10", className)}
    {...restProps}
  />
  <Button
    variant="ghost"
    size="icon-sm"
    type="button"
    class="absolute top-1/2 end-1 -translate-y-1/2"
    aria-label="Show value"
    aria-pressed={shown}
    onclick={() => (shown = !shown)}
  >
    {#if shown}
      <EyeOffIcon />
    {:else}
      <EyeIcon />
    {/if}
  </Button>
</div>
