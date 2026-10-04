<script lang="ts">
import { client } from "$lib/api.ts";
import type { ItemDetail } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
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

async function request(event: SubmitEvent) {
  event.preventDefault();
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
  <form class="store" onsubmit={request}>
    {#if rungs.length === 0}
      <p class="muted">
        This library stores no Versions.
        <a href="/admin/libraries/{detail.libraryId}"
          >Choose its stored Versions</a
        >
      </p>
    {:else}
      <label for="storeRung">Store a Version</label>
      <div class="row">
        <select id="storeRung" bind:value={rung}>
          {#each rungs as option (option.name)}
            <option value={option.name}>{rungLabel(option)}</option>
          {/each}
        </select>
        <button type="submit" disabled={busy}>Queue</button>
      </div>
      {#if failure}
        <Failure {failure} />
      {/if}
      <p class="muted" role="status">{result}</p>
    {/if}
  </form>
{/if}

<style>
  .store {
    display: grid;
    max-width: 480px;
    gap: 8px;
    margin-top: 16px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  p {
    min-height: 1.5em;
    margin: 0;
  }
</style>
