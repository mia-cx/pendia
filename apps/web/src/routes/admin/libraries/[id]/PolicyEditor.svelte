<script lang="ts">
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import {
  droppedRungs,
  fromDraft,
  type PolicyDraft,
  type StoredPolicy,
  toDraft,
} from "$lib/stored.ts";

// The route keys this component on the id, so it never outlives its library.
const { id }: { id: string } = $props();

const library = resource(() => client.libraries.get({ id }));
const policy = resource(() => client.libraries.storedVersions({ id }));

const maxRungs = 8;

let draft = $state<PolicyDraft | null>(null);
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let saved = $state(false);
let confirming = $state<string[] | null>(null);

$effect(() => {
  if (draft === null && policy.data) draft = toDraft(policy.data.policy);
});

const rungCount = $derived(
  draft === null ? 0 : draft.rungs.length + (draft.keepSource ? 1 : 0),
);

function addRung() {
  draft?.rungs.push({ name: "", height: "", bitrateMbps: "" });
  saved = false;
}

function removeRung(index: number) {
  draft?.rungs.splice(index, 1);
  saved = false;
}

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (draft === null || !policy.data) return;
  const dropped = droppedRungs(policy.data.policy, fromDraft(draft));
  if (dropped.length > 0) {
    confirming = dropped;
    return;
  }
  void save();
}

async function save() {
  if (draft === null) return;
  confirming = null;
  busy = true;
  failure = undefined;
  saved = false;
  const next: StoredPolicy = fromDraft(draft);
  try {
    const answer = await client.libraries.setStoredVersions({
      id,
      policy: next,
    });
    policy.set(answer);
    draft = toDraft(answer.policy);
    saved = true;
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}
</script>

<svelte:head>
  <title>{library.data?.name ?? "Library"} · Pendia admin</title>
</svelte:head>

<h2>{library.data?.name ?? "Library"}</h2>
{#if library.data}
  <p class="muted path">{library.data.rootPath}</p>
{/if}

<section aria-labelledby="stored-heading">
  <h3 id="stored-heading">Stored Versions</h3>
  {#if policy.failure}
    <Failure failure={policy.failure} />
  {:else if draft === null}
    <p class="muted">Loading.</p>
  {:else}
    <!-- Any edit hides the last save's notice. Number fields keep their text,
         because bind:value would hand the draft numbers. -->
    <form onsubmit={submit} oninput={() => (saved = false)}>
      <fieldset>
        <legend>Rungs</legend>
        <div class="check">
          <input
            id="keepSource"
            type="checkbox"
            bind:checked={draft.keepSource}
          />
          <label for="keepSource">Store the source, remuxed</label>
        </div>
        {#if draft.rungs.length > 0}
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Height</th>
                <th>Mbit/s</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each draft.rungs as rung, index (index)}
                <tr>
                  <td>
                    <input
                      aria-label="Rung {index + 1} name"
                      placeholder={rung.height === "" ? "" : `${rung.height}p`}
                      maxlength="32"
                      bind:value={rung.name}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Rung {index + 1} height in pixels"
                      type="number"
                      inputmode="numeric"
                      required
                      min="144"
                      max="4320"
                      step="2"
                      value={rung.height}
                      oninput={(event) =>
                        (rung.height = event.currentTarget.value)}
                    />
                  </td>
                  <td>
                    <input
                      aria-label="Rung {index + 1} bitrate in Mbit/s"
                      type="number"
                      inputmode="decimal"
                      required
                      min="0.1"
                      max="200"
                      step="0.1"
                      value={rung.bitrateMbps}
                      oninput={(event) =>
                        (rung.bitrateMbps = event.currentTarget.value)}
                    />
                  </td>
                  <td class="actions">
                    <button type="button" onclick={() => removeRung(index)}
                      >Remove</button
                    >
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        <button
          type="button"
          onclick={addRung}
          disabled={rungCount >= maxRungs}>Add rung</button
        >
      </fieldset>

      <fieldset>
        <legend>Sources</legend>
        <p class="muted">
          A source is stored when it matches any field. Leave all empty to
          store every source.
        </p>
        <label for="minHeight">At least this tall, in pixels</label>
        <input
          id="minHeight"
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          value={draft.minHeight}
          oninput={(event) => {
            if (draft) draft.minHeight = event.currentTarget.value;
          }}
        />
        <label for="codecs">Video codecs</label>
        <input id="codecs" placeholder="hevc, av1" bind:value={draft.codecs} />
        <div class="check">
          <input id="hdr" type="checkbox" bind:checked={draft.hdr} />
          <label for="hdr">HDR</label>
        </div>
      </fieldset>

      {#if failure}
        <Failure {failure} />
      {/if}
      {#if confirming}
        <div class="confirm" role="alert">
          <p>
            Saving deletes the stored {confirming.join(", ")}
            {confirming.length === 1 ? "rung" : "rungs"} of every Item in this
            library.
          </p>
          <button type="button" onclick={save} disabled={busy}
            >Save and delete</button
          >
          <button type="button" onclick={() => (confirming = null)}
            >Cancel</button
          >
        </div>
      {:else}
        <div class="submit">
          <button type="submit" disabled={busy}>Save</button>
          {#if saved}
            <p role="status">
              Saved. <a href="/admin/activity">Follow store jobs in Activity</a>
            </p>
          {/if}
        </div>
      {/if}
    </form>
  {/if}
</section>

<style>
section {
  max-width: 720px;
}

.path {
  margin-top: -8px;
  overflow-wrap: anywhere;
}

form {
  display: grid;
  gap: 24px;
}

fieldset {
  display: grid;
  max-width: 480px;
  gap: 8px;
  justify-items: start;
}

fieldset > input {
  width: 100%;
}

legend {
  margin-bottom: 8px;
  padding: 0;
  font-weight: 600;
}

fieldset p {
  margin: 0;
}

table {
  table-layout: fixed;
}

th,
td {
  padding: 6px 8px 6px 0;
}

td input {
  width: 100%;
}

th:last-child,
td.actions {
  width: 96px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}

.check label {
  font-weight: 400;
}

.submit,
.confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}

.submit p,
.confirm p {
  flex-basis: 100%;
  margin: 0;
}

.submit p {
  flex-basis: auto;
}
</style>
