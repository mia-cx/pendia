<script lang="ts">
import { tick } from "svelte";
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import {
  queuesScan,
  type RootDraft,
  refusedRoot,
  removedRoots,
} from "$lib/roots.ts";

// The route keys this component on the id, so it never outlives its library.
const { id }: { id: string } = $props();

const library = resource(() => client.libraries.get({ id }));

let loaded = false;
let name = $state("");
let draft = $state<RootDraft[]>([]);
let inputs: HTMLInputElement[] = [];
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let refusal = $state<{ index: number; message: string } | undefined>(undefined);
let notice = $state("");
let confirming = $state<{ id: string; path: string }[] | null>(null);
let copied = $state("");

// The clipboard API exists only in a secure context, so plain HTTP selects instead.
let canCopy = $state(
  typeof navigator !== "undefined" && "clipboard" in navigator,
);

$effect(() => {
  if (!loaded && library.data) {
    loaded = true;
    name = library.data.name;
    draft = library.data.roots.map((root) => ({ ...root }));
  }
});

async function copyId(rootId: string) {
  try {
    await navigator.clipboard.writeText(rootId);
    copied = rootId;
  } catch {
    // A denied clipboard leaves the selectable field as the way to copy.
    canCopy = false;
  }
}

async function addFolderRow() {
  draft = [...draft, { path: "" }];
  await tick();
  inputs[draft.length - 1]?.focus();
}

function removeRow(index: number) {
  draft = draft.filter((_, i) => i !== index);
  if (refusal?.index === index) refusal = undefined;
}

function submit(event: SubmitEvent) {
  event.preventDefault();
  const saved = library.data?.roots;
  if (!saved) return;
  const removed = removedRoots(saved, draft);
  if (removed.length > 0) {
    confirming = removed;
    return;
  }
  void save();
}

async function save() {
  const saved = library.data?.roots;
  if (!saved) return;
  confirming = null;
  busy = true;
  failure = undefined;
  refusal = undefined;
  notice = "";
  const sent = draft;
  try {
    const answer = await client.libraries.update({ id, name, roots: sent });
    library.set(answer);
    name = answer.name;
    draft = answer.roots.map((root) => ({ ...root }));
    notice = queuesScan(saved, sent)
      ? "Saved. A scan of this library is queued."
      : "Saved.";
  } catch (error) {
    const refused = refusedRoot(error);
    if (refused !== undefined && refused.index < sent.length) refusal = refused;
    else failure = readFailure(error);
  } finally {
    busy = false;
  }
}
</script>

<svelte:head>
  <title>{library.data?.name ?? "Library"} · Pendia admin</title>
</svelte:head>

<h2>{library.data?.name ?? "Library"}</h2>

<section aria-labelledby="details-heading">
  <h3 id="details-heading">Details</h3>
  {#if library.failure}
    <Failure failure={library.failure} />
  {:else if !library.data}
    <p class="muted">Loading.</p>
  {:else}
    <form onsubmit={submit} oninput={() => (notice = "")}>
      <label for="libraryName">Name</label>
      <input id="libraryName" required bind:value={name} />

      <fieldset>
        <legend>Folders</legend>
        {#each draft as row, index (index)}
          <div class="folder">
            <input
              aria-label="Folder {index + 1} path"
              required
              bind:this={inputs[index]}
              bind:value={draft[index].path}
              aria-invalid={refusal?.index === index ? "true" : undefined}
              aria-describedby={refusal?.index === index
                ? `folderError${index}`
                : undefined}
              oninput={() => {
                if (refusal?.index === index) refusal = undefined;
              }}
            />
            {#if draft.length > 1}
              <button type="button" onclick={() => removeRow(index)}
                >Remove</button
              >
            {/if}
          </div>
          {#if refusal?.index === index}
            <p class="field-error" id="folderError{index}">{refusal.message}</p>
          {/if}
          {#if row.id}
            <div class="root-id">
              <label for="rootId{index}">ID</label>
              <input
                id="rootId{index}"
                class="mono"
                readonly
                value={row.id}
                onclick={(event) => event.currentTarget.select()}
              />
              {#if canCopy}
                <button type="button" onclick={() => copyId(row.id ?? "")}
                  >{copied === row.id ? "Copied" : "Copy ID"}</button
                >
              {/if}
            </div>
          {/if}
        {/each}
        <button type="button" onclick={addFolderRow}>Add folder</button>
      </fieldset>

      {#if failure}
        <Failure {failure} />
      {/if}
      {#if confirming}
        <div class="confirm" role="alert">
          {#if confirming.length === 1}
            <p>
              Remove {confirming[0]?.path}? Its files, and the watch history
              of anything only in this folder, will leave this library.
            </p>
          {:else}
            <p>
              Remove {confirming.length} folders? Their files, and the watch
              history of anything only in them, will leave this library.
            </p>
            <ul>
              {#each confirming as root (root.id)}
                <li>{root.path}</li>
              {/each}
            </ul>
          {/if}
          <button type="button" onclick={save} disabled={busy}
            >Remove and save</button
          >
          <button type="button" onclick={() => (confirming = null)}
            >Cancel</button
          >
        </div>
      {:else}
        <div class="submit">
          <button type="submit" disabled={busy}>Save changes</button>
          {#if notice}
            <p role="status">{notice}</p>
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

form {
  display: grid;
  max-width: 480px;
  gap: 16px;
}

fieldset {
  display: grid;
  gap: 8px;
  justify-items: start;
  width: 100%;
}

fieldset legend {
  padding: 0;
  font-weight: 600;
}

fieldset > p {
  margin: 0;
}

.folder {
  display: flex;
  width: 100%;
  gap: 8px;
}

.folder input {
  flex: 1;
  min-width: 0;
}

.field-error {
  margin: 0;
  color: var(--danger);
}

.root-id {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  width: 100%;
  gap: 4px 8px;
}

.root-id label {
  font-weight: 400;
}

.root-id .mono {
  flex: 1;
  min-width: 0;
  font-family: monospace;
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
  margin: 0;
}

.confirm p,
.confirm ul {
  flex-basis: 100%;
}

.confirm ul {
  margin: 0;
}
</style>
