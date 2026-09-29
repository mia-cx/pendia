<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import { type ScanStatus, waitForScan } from "$lib/scan.ts";

const list = resource(() => client.libraries.list());
const denied = $derived(
  list.failure?.code === "FORBIDDEN" || list.failure?.code === "UNAUTHORIZED",
);
type LibraryRow = NonNullable<typeof list.data>[number];

const mediumNames: Record<LibraryRow["medium"], string> = {
  movies: "Movies",
  shows: "Shows",
};

let statuses = $state<Record<string, ScanStatus>>({});
let statusFailures = $state<Record<string, string>>({});

const statusTickets = new Map<string, number>();

function claimStatus(id: string): number {
  const ticket = (statusTickets.get(id) ?? 0) + 1;
  statusTickets.set(id, ticket);
  return ticket;
}

function holdsStatus(id: string, ticket: number): boolean {
  return statusTickets.get(id) === ticket;
}

let addName = $state("");
let addRoot = $state("");
let addMedium = $state<LibraryRow["medium"]>("movies");
let addBusy = $state(false);
let addFailure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let addNotice = $state("");

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
let scanRuns = $state<Record<string, string>>({});

const controller = new AbortController();
onDestroy(() => controller.abort());

$effect(() => {
  const rows = list.data;
  if (!rows) return;
  void loadStatuses(rows);
});

async function loadStatuses(rows: readonly LibraryRow[]) {
  const targets = untrack(() =>
    rows.filter((row) => scanBusy[row.id] !== true),
  );
  await Promise.all(
    targets.map(async (row) => {
      const ticket = claimStatus(row.id);
      try {
        const status = await client.libraries.scanStatus({ id: row.id });
        if (!holdsStatus(row.id, ticket)) return;
        statuses[row.id] = status;
        delete statusFailures[row.id];
        delete scanFailures[row.id];
      } catch {
        if (!holdsStatus(row.id, ticket)) return;
        delete statuses[row.id];
        statusFailures[row.id] = "The scan status could not be read.";
      }
    }),
  );
}

async function addLibrary(event: SubmitEvent) {
  event.preventDefault();
  addBusy = true;
  addFailure = undefined;
  addNotice = "";
  const name = addName;
  const medium = addMedium;
  const root = addRoot;
  try {
    const created = await client.libraries.create({
      name,
      medium,
      rootPath: root,
    });
    if (addName === name) addName = "";
    if (addRoot === root) addRoot = "";
    addNotice = `Added ${created.name}.`;
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
  const name = editName;
  try {
    await client.libraries.update({ id: row.id, name });
    if (editingId === row.id && editName === name) editingId = null;
    await list.reload();
  } catch (error) {
    if (editingId === row.id) editFailure = readFailure(error);
  } finally {
    editBusy = false;
  }
}

/** Starts a scan and follows it, or follows the run this row already started. */
async function scanNow(row: LibraryRow) {
  scanBusy[row.id] = true;
  delete scanFailures[row.id];
  delete statusFailures[row.id];
  const ticket = claimStatus(row.id);
  try {
    const jobId =
      scanRuns[row.id] ?? (await client.libraries.scan({ id: row.id })).jobId;
    scanRuns[row.id] = jobId;
    const settled = await waitForScan(client, row.id, {
      signal: controller.signal,
      runId: jobId,
      onStatus: (reading) => {
        if (holdsStatus(row.id, ticket)) statuses[row.id] = reading;
      },
    });
    if (holdsStatus(row.id, ticket)) statuses[row.id] = settled;
    delete scanRuns[row.id];
  } catch (error) {
    scanFailures[row.id] =
      error instanceof Error
        ? error.message
        : "The scan status could not be read.";
  } finally {
    scanBusy[row.id] = false;
  }
}

function startDelete(row: LibraryRow) {
  confirmingId = row.id;
  deleteFailure = undefined;
}

async function confirmDelete(row: LibraryRow) {
  deleteBusy = true;
  deleteFailure = undefined;
  try {
    await client.libraries.delete({ id: row.id });
    if (confirmingId === row.id) confirmingId = null;
    await list.reload();
  } catch (error) {
    if (confirmingId === row.id) deleteFailure = readFailure(error);
  } finally {
    deleteBusy = false;
  }
}

/** The run's state read from its job counts, because one child job is not the run. */
function scanCell(row: LibraryRow): string {
  const status = statuses[row.id];
  if (!status || status.latest === null) return "Not scanned";
  const { counts } = status;
  const failed = counts.failed > 0 ? `, ${counts.failed} failed` : "";
  if (counts.running > 0) return `Running${failed}`;
  if (counts.queued > 0) return `Queued${failed}`;
  if (counts.completed > 0) return `Completed${failed}`;
  if (counts.failed > 0)
    return counts.failed === 1 ? "Failed" : `${counts.failed} failed`;
  return "Not scanned";
}
</script>

<svelte:head>
  <title>Libraries · Pendia admin</title>
</svelte:head>

<h2>Libraries</h2>

<p>
  <button
    type="button"
    onclick={() => list.reload()}
    disabled={list.loading}>Refresh</button
  >
</p>
{#if list.failure}
  <Failure failure={list.failure} />
{:else}
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
                disabled={scanBusy[row.id] === true}
                >{scanRuns[row.id] === undefined
                  ? "Scan now"
                  : "Check again"}</button
              >
              <button type="button" onclick={() => startRename(row)}
                >Rename</button
              >
              <button type="button" onclick={() => startDelete(row)}
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

{#if !denied}
<form onsubmit={addLibrary}>
  <h3>Add a library</h3>
  {#if addFailure}
    <Failure failure={addFailure} />
  {/if}
  {#if addNotice}
    <p class="muted">{addNotice}</p>
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
{/if}

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
