<script lang="ts">
import { client } from "$lib/api.ts";
import type { ItemDetail } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import { rungLabel } from "$lib/stored.ts";

const { detail }: { detail: ItemDetail } = $props();

// Only a caller holding manage-transcoding can read the policy; for anyone
// else the control stays away.
const policy = resource(() =>
  client.libraries.storedVersions({ id: detail.libraryId }),
);
const hidden = $derived(
  policy.failure?.code === "FORBIDDEN" ||
    policy.failure?.code === "UNAUTHORIZED",
);

let rung = $state("");
let busy = $state(false);
let result = $state("");
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

$effect(() => {
  const first = policy.data?.policy?.rungs[0];
  if (rung === "" && first) rung = first.name;
});

async function request() {
  busy = true;
  result = "";
  failure = undefined;
  const name = rung;
  try {
    const { queued } = await client.items.requestStoredVersion({
      id: detail.id,
      rung: name,
    });
    result = queued
      ? `Queued ${name}.`
      : `${name} is already stored or queued.`;
  } catch (error) {
    const read = readFailure(error);
    failure =
      read.code === "CONFLICT"
        ? {
            code: read.code,
            message: `This Item's source cannot make ${name}.`,
          }
        : read;
  } finally {
    busy = false;
  }
}
</script>

{#if policy.failure && !hidden}
  <Failure failure={policy.failure} />
{:else if policy.data}
  {@const rungs = policy.data.policy?.rungs ?? []}
  {#if rungs.length === 0}
    <p class="text-subheadline text-label-secondary">
      This library stores no Versions.
      <a
        href="/admin/libraries/{detail.libraryId}"
        class="text-label underline underline-offset-2"
        >Choose its stored Versions</a
      >
    </p>
  {:else}
    <div class="flex max-w-[30rem] items-center gap-3">
      <span class="shrink-0 text-subheadline">Store a Version</span>
      <Select.Root
        type="single"
        value={rung}
        onValueChange={(value) => (rung = value)}
      >
        <Select.Trigger class="min-w-0 flex-1" aria-label="Version to store">
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          {#each rungs as option (option.name)}
            <Select.Item value={option.name}>{rungLabel(option)}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Button
        variant="secondary"
        disabled={busy || rung === ""}
        onclick={() => void request()}
      >
        Queue
      </Button>
    </div>
    {#if failure}
      <Failure {failure} />
    {/if}
    <p role="status" class="min-h-[1lh] text-subheadline text-label-secondary">
      {result}
    </p>
  {/if}
{/if}
