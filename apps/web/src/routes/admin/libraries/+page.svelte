<script lang="ts">
import { onDestroy } from "svelte";
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import { type ScanStatus, waitForScan } from "$lib/scan.ts";

const list = resource(() => client.libraries.list());
type LibraryRow = NonNullable<typeof list.data>[number];

const mediumNames: Record<LibraryRow["medium"], string> = {
  movies: "Movies",
  shows: "Shows",
};

let statuses = $state<Record<string, ScanStatus>>({});
let statusFailures = $state<Record<string, string>>({});
let statusTicket = 0;

let addName = $state("");
let addRoot = $state("");
let addMedium = $state<LibraryRow["medium"]>("movies");
let addBusy = $state(false);
let addFailure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

let editingId = $state<string | null>(null);
let editName = $state("");
let editBusy = $state(false);
let editFailure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

let confirmingId = $state<string | null>(null);
let deleteBusy = $state(false);
let deleteFailure = $state<ReturnType<typeof readFailure> | undefined>(
  undefined,
);

let scanBusy = $state<Record<string, boolean>>({});
let scanFailures = $state<Record<string, string>>({});

const controller = new AbortController();
onDestroy(() => controller.abort());

$effect(() => {
  const rows = list.data;
  if (!rows) return;
  void loadStatuses(rows);
});

async function loadStatuses(rows: readonly LibraryRow[]) {
  const ticket = ++statusTicket;
  statuses = {};
  statusFailures = {};
  const results = await Promise.all(
    rows.map(async (row) => {
      try {
        return {
          id: row.id,
          status: await client.libraries.scanStatus({ id: row.id }),
        };
      } catch {
        return { id: row.id, status: undefined };
      }
    }),
  );
  if (ticket !== statusTicket) return;
  const next: Record<string, ScanStatus> = {};
  const failed: Record<string, string> = {};
  for (const result of results) {
    if (result.status) next[result.id] = result.status;
    else failed[result.id] = "The scan status could not be read.";
  }
  statuses = next;
  statusFailures = failed;
}

async function addLibrary(event: SubmitEvent) {
  event.preventDefault();
  addBusy = true;
  addFailure = undefined;
  try {
    await client.libraries.create({
      name: addName,
      medium: addMedium,
      rootPath: addRoot,
    });
    addName = "";
    addRoot = "";
    await list.reload();
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}

function startRename(row: LibraryRow) {
  editingId = row.id;
  editName = row.name;
  editFailure = undefined;
}

async function saveRename(row: LibraryRow) {
  editBusy = true;
  editFailure = undefined;
  try {
    await client.libraries.update({ id: row.id, name: editName });
    editingId = null;
    await list.reload();
  } catch (error) {
    editFailure = readFailure(error);
  } finally {
    editBusy = false;
  }
}

async function scanNow(row: LibraryRow) {
  scanBusy[row.id] = true;
  delete scanFailures[row.id];
  try {
    const { jobId } = await client.libraries.scan({ id: row.id });
    statuses[row.id] = await waitForScan(client, row.id, {
      signal: controller.signal,
      runId: jobId,
      onStatus: (reading) => {
        statuses[row.id] = reading;
      },
    });
  } catch (error) {
    scanFailures[row.id] =
      error instanceof Error
        ? error.message
        : "The scan status could not be read.";
  } finally {
    scanBusy[row.id] = false;
  }
}

async function confirmDelete(row: LibraryRow) {
  deleteBusy = true;
  deleteFailure = undefined;
  try {
    await client.libraries.delete({ id: row.id });
    confirmingId = null;
    await list.reload();
  } catch (error) {
    deleteFailure = readFailure(error);
  } finally {
    deleteBusy = false;
  }
}

const stateLabels = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

function scanCell(row: LibraryRow): string {
  const status = statuses[row.id];
  const latest = status?.latest;
  if (!status || !latest) return "Not scanned";
  const failed =
    status.counts.failed > 0 ? `, ${status.counts.failed} failed` : "";
  return `${stateLabels[latest.state]}${failed}`;
}
</script>

<svelte:head>
  <title>Libraries · Pendia admin</title>
</svelte:head>

<h2>Libraries</h2>

{#if list.failure}
  <Failure failure={list.failure} />
{:else}
  <p>
    <button
      type="button"
      onclick={() => list.reload()}
      disabled={list.loading}>Refresh</button
    >
  </p>
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Medium</th>
        <th>Root path</th>
        <th>Scan</th>
        <th><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#each list.data ?? [] as row (row.id)}
        <tr>
          <td class="name">
            {#if editingId === row.id}
              <input
                aria-label="Library name"
                required
                bind:value={editName}
              />
              {#if editFailure}
                <Failure failure={editFailure} />
              {/if}
            {:else}
              {row.name}
            {/if}
          </td>
          <td>{mediumNames[row.medium]}</td>
          <td class="path">{row.rootPath}</td>
          <td class="scan">
            {#if scanFailures[row.id]}
              {scanFailures[row.id]}
            {:else if statusFailures[row.id]}
              {statusFailures[row.id]}
            {:else}
              {scanCell(row)}
            {/if}
          </td>
          <td class="actions">
            {#if confirmingId === row.id}
              <span
                >Delete this library? Its database records are removed; the
                files stay.</span
              >
              <button
                type="button"
                onclick={() => confirmDelete(row)}
                disabled={deleteBusy}>Yes</button
              >
              <button type="button" onclick={() => (confirmingId = null)}
                >Cancel</button
              >
              {#if deleteFailure}
                <Failure failure={deleteFailure} />
              {/if}
            {:else if editingId === row.id}
              <button
                type="button"
                onclick={() => saveRename(row)}
                disabled={editBusy}>Save</button
              >
              <button type="button" onclick={() => (editingId = null)}
                >Cancel</button
              >
            {:else}
              <button
                type="button"
                onclick={() => scanNow(row)}
                disabled={scanBusy[row.id] === true}>Scan now</button
              >
              <button type="button" onclick={() => startRename(row)}
                >Rename</button
              >
              <button type="button" onclick={() => (confirmingId = row.id)}
                >Delete</button
              >
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if (list.data ?? []).length === 0}
    <p class="muted">No libraries yet.</p>
  {/if}
{/if}

<form onsubmit={addLibrary}>
  <h3>Add a library</h3>
  {#if addFailure}
    <Failure failure={addFailure} />
  {/if}
  <label for="addName">Name</label>
  <input id="addName" name="name" required bind:value={addName} />
  <label for="addRoot">Root path</label>
  <input id="addRoot" name="rootPath" required bind:value={addRoot} />
  <p class="muted">Enter an absolute path on the server, like /srv/movies.</p>
  <label for="addMedium">Medium</label>
  <select id="addMedium" name="medium" bind:value={addMedium}>
    {#each Object.entries(mediumNames) as [value, label] (value)}
      <option {value}>{label}</option>
    {/each}
  </select>
  <button type="submit" disabled={addBusy}>Add library</button>
</form>

<style>
table {
  table-layout: fixed;
}

td {
  height: 48px;
  vertical-align: middle;
}

.name,
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name input {
  width: 100%;
}

.actions {
  white-space: nowrap;
}

.actions button {
  margin-right: 8px;
}

form {
  display: grid;
  max-width: 360px;
  margin-top: 32px;
  gap: 8px;
}

form h3 {
  margin: 0 0 8px;
}

form :global(.failure) {
  margin-bottom: 4px;
}
</style>
