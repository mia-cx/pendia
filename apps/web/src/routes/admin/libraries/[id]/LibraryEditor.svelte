<script lang="ts">
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import FolderFields from "$lib/components/FolderFields.svelte";
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
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let refusal = $state<{ index: number; message: string } | undefined>(undefined);
let notice = $state("");
let confirming = $state<{ id: string; path: string }[] | null>(null);

$effect(() => {
  if (!loaded && library.data) {
    loaded = true;
    name = library.data.name;
    draft = library.data.roots.map((root) => ({ ...root }));
  }
});

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
  const sent = $state.snapshot(draft);
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

      <FolderFields bind:rows={draft} bind:refusal idPrefix="edit" />

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
