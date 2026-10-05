<script lang="ts">
import PuzzleIcon from "@lucide/svelte/icons/puzzle";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import Failure from "$lib/components/Failure.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Switch } from "$lib/components/ui/switch/index.ts";
import type { FailureCode } from "$lib/errors.ts";
import type { InstalledPlugin } from "$lib/plugins.ts";

/** One installed plugin as a card: status, switch, and its actions. */
const {
  plugin,
  origin,
  busy,
  failure,
  ontoggle,
  onconfigure,
  onremove,
}: {
  plugin: InstalledPlugin;
  origin: string;
  busy: boolean;
  failure?: { code: FailureCode; message: string };
  ontoggle: (enabled: boolean) => void;
  onconfigure: () => void;
  onremove: () => Promise<void>;
} = $props();

const titleId = $props.id();

function failedAt(at: string) {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
</script>

<li>
  <article
    aria-labelledby={titleId}
    class="flex h-full flex-col rounded-lg bg-elevated p-4 contrast-more:ring-1 contrast-more:ring-separator"
  >
    <div class="flex items-start gap-3">
      <span
        class="flex size-10 shrink-0 items-center justify-center rounded-md bg-fill-strong text-label"
      >
        <PuzzleIcon class="size-5" aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 id={titleId} class="text-headline break-words">{plugin.name}</h3>
        <p class="text-footnote text-label-secondary">
          {plugin.version} · {origin}
        </p>
      </div>
      {#if !plugin.failure}
        <Switch
          checked={plugin.enabled}
          aria-label={plugin.name}
          disabled={busy}
          onCheckedChange={(enabled) => ontoggle(enabled)}
        />
      {/if}
    </div>
    <div class="mt-3 flex items-center gap-2 text-footnote">
      <span
        class="size-2 shrink-0 rounded-full {plugin.failure
          ? 'bg-destructive'
          : plugin.enabled
            ? 'bg-success'
            : 'bg-label-tertiary'}"
        aria-hidden="true"
      ></span>
      <span class="text-label-secondary">
        {#if plugin.failure}
          Failed {failedAt(plugin.failure.at)}
        {:else if plugin.enabled}
          On
        {:else}
          Off
        {/if}
      </span>
    </div>
    {#if plugin.failure}
      <p class="mt-1 text-footnote text-label-secondary line-clamp-2">
        {plugin.failure.message}
      </p>
    {/if}
    {#if failure}
      <div class="mt-3">
        <Failure {failure} />
      </div>
    {/if}
    <div class="mt-auto flex flex-wrap gap-2 pt-4">
      {#if plugin.failure}
        <Button
          size="sm"
          variant="tinted"
          onclick={() => ontoggle(true)}
          disabled={busy}>Restart</Button
        >
      {/if}
      <Button size="sm" variant="secondary" onclick={onconfigure}
        >Configure</Button
      >
      <ConfirmDialog
        title="Remove {plugin.name}?"
        description="{plugin.name} stops running, and its settings are deleted.{plugin
          .capabilities.includes('items:write')
          ? ' Tags it added stay on your items.'
          : ''}"
        action="Remove plugin"
        onconfirm={onremove}
      >
        {#snippet trigger(props)}
          <Button {...props} size="sm" variant="ghost" class="text-destructive"
            >Remove</Button
          >
        {/snippet}
      </ConfirmDialog>
    </div>
  </article>
</li>
