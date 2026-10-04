<script lang="ts">
import { readFailure } from "$lib/errors.ts";
import { type FilesOff, filesChoice, filesOffFor } from "$lib/plugins.ts";
import Failure from "./Failure.svelte";

const {
  id,
  label,
  off,
  save,
}: {
  id: string;
  label: string;
  off: FilesOff;
  save: (off: FilesOff) => Promise<void>;
} = $props();

let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

const current = $derived(filesChoice(off));
const until = $derived(
  off?.until
    ? new Date(off.until).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "",
);

async function change(select: HTMLSelectElement) {
  const choice = select.value;
  if (
    choice !== "on" &&
    choice !== "hour" &&
    choice !== "day" &&
    choice !== "off"
  )
    return;
  busy = true;
  failure = undefined;
  try {
    await save(filesOffFor(choice));
  } catch (error) {
    failure = readFailure(error);
    select.value = current;
  } finally {
    busy = false;
  }
}
</script>

<div class="switch">
  <label for={id}>{label}</label>
  <select
    {id}
    value={current}
    onchange={(event) => change(event.currentTarget)}
    disabled={busy}
  >
    <option value="on">On</option>
    {#if current === "until"}
      <option value="until">Off until {until}</option>
    {/if}
    <option value="hour">Off for an hour</option>
    <option value="day">Off for a day</option>
    <option value="off">Off</option>
  </select>
</div>
{#if failure}
  <Failure {failure} />
{/if}

<style>
.switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
</style>
