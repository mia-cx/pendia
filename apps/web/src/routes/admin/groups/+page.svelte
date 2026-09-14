<script lang="ts">
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { type Permission, permissionNames } from "$lib/permissions.ts";
import { resource } from "$lib/resource.svelte.ts";

const list = resource(() => client.groups.list());
type GroupRow = NonNullable<typeof list.data>[number];

type FailureShape = ReturnType<typeof readFailure>;

let addName = $state("");
let addPerms = $state<Permission[]>([]);
let addBusy = $state(false);
let addFailure = $state<FailureShape | undefined>(undefined);

let editingId = $state<string | null>(null);
let editPerms = $state<Permission[]>([]);
let editBusy = $state(false);
let editFailure = $state<FailureShape | undefined>(undefined);

function ordered(row: GroupRow): Permission[] {
  return permissionNames.filter((name) => row.permissions.includes(name));
}

function samePermissions(a: readonly Permission[], b: readonly Permission[]) {
  return a.length === b.length && a.every((perm) => b.includes(perm));
}

async function addGroup(event: SubmitEvent) {
  event.preventDefault();
  addBusy = true;
  addFailure = undefined;
  const name = addName;
  const perms = [...addPerms];
  try {
    await client.groups.create({ name, permissions: perms });
    if (addName === name) addName = "";
    if (samePermissions(addPerms, perms)) addPerms = [];
    await list.reload();
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}

function startEdit(row: GroupRow) {
  editingId = row.id;
  editPerms = [...row.permissions];
  editFailure = undefined;
}

async function saveEdit(row: GroupRow) {
  editBusy = true;
  editFailure = undefined;
  const perms = [...editPerms];
  try {
    await client.groups.setPermissions({ id: row.id, permissions: perms });
    if (editingId === row.id && samePermissions(editPerms, perms))
      editingId = null;
    await list.reload();
  } catch (error) {
    if (editingId === row.id) editFailure = readFailure(error);
  } finally {
    editBusy = false;
  }
}
</script>

<svelte:head>
  <title>Groups · Pendia admin</title>
</svelte:head>

<h2>Groups</h2>
<p class="muted">
  The built-in admins and users groups cannot be edited, because admins bypass
  every permission check and users is the default group.
</p>

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
        <th>Built in</th>
        <th>Permissions</th>
        <th><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#each list.data ?? [] as row (row.id)}
        <tr>
          <td class="name">{row.name}</td>
          <td>{row.builtIn ? "Yes" : "No"}</td>
          <td class="perms">
            {#if editingId === row.id}
              <div class="checks">
                {#each permissionNames as permission (permission)}
                  <span class="check">
                    <input
                      id={`edit-${row.id}-${permission}`}
                      type="checkbox"
                      bind:group={editPerms}
                      value={permission}
                    />
                    <label for={`edit-${row.id}-${permission}`}
                      >{permission}</label
                    >
                  </span>
                {/each}
              </div>
              {#if editFailure}
                <Failure failure={editFailure} />
              {/if}
            {:else}
              {ordered(row).join(", ") || "None"}
            {/if}
          </td>
          <td class="actions">
            {#if !row.builtIn}
              {#if editingId === row.id}
                <button
                  type="button"
                  onclick={() => saveEdit(row)}
                  disabled={editBusy}>Save</button
                >
                <button type="button" onclick={() => (editingId = null)}
                  >Cancel</button
                >
              {:else}
                <button
                  type="button"
                  onclick={() => startEdit(row)}
                  disabled={editingId !== null}>Edit</button
                >
              {/if}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<form onsubmit={addGroup}>
  <h3>Create a group</h3>
  {#if addFailure}
    <Failure failure={addFailure} />
  {/if}
  <label for="addName">Name</label>
  <input id="addName" name="name" required bind:value={addName} />
  <fieldset>
    <legend>Permissions</legend>
    {#each permissionNames as permission (permission)}
      <span class="check">
        <input
          id={`add-${permission}`}
          type="checkbox"
          bind:group={addPerms}
          value={permission}
        />
        <label for={`add-${permission}`}>{permission}</label>
      </span>
    {/each}
  </fieldset>
  <button type="submit" disabled={addBusy}>Create group</button>
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
.perms {
  overflow: hidden;
}

.name {
  text-overflow: ellipsis;
  white-space: nowrap;
}

.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.check label {
  font-weight: 400;
}

.actions {
  white-space: nowrap;
}

.actions button {
  margin-right: 8px;
}

form {
  display: grid;
  max-width: 480px;
  margin-top: 32px;
  gap: 8px;
  align-content: start;
}

form h3 {
  margin: 0 0 4px;
}

form :global(.failure) {
  margin-bottom: 4px;
}

fieldset {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0;
  padding: 8px 12px 12px;
  border: 1px solid var(--muted);
}

legend {
  padding: 0 4px;
}
</style>
