<script lang="ts">
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import Failure from "$lib/components/Failure.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Dialog from "$lib/components/ui/dialog/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Switch } from "$lib/components/ui/switch/index.ts";
import { readFailure } from "$lib/errors.ts";
import {
  type Permission,
  permissionLabels,
  permissionNames,
} from "$lib/permissions.ts";
import { resource } from "$lib/resource.svelte.ts";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();
const adminLocked = $derived(!data.me.admin);

const list = resource(() => client.groups.list());
const denied = $derived(
  list.failure?.code === "FORBIDDEN" || list.failure?.code === "UNAUTHORIZED",
);
type GroupRow = NonNullable<typeof list.data>[number];

type FailureShape = ReturnType<typeof readFailure>;

let addName = $state("");
let addPerms = $state<Permission[]>([]);
let addBusy = $state(false);
let addFailure = $state<FailureShape | undefined>(undefined);

let editing: GroupRow | undefined = $state(undefined);
let editOpen = $state(false);
let editPerms = $state<Permission[]>([]);
let editBusy = $state(false);
let editFailure = $state<FailureShape | undefined>(undefined);

function ordered(row: GroupRow): Permission[] {
  return permissionNames.filter((name) => row.permissions.includes(name));
}

function caption(row: GroupRow): string {
  if (row.builtIn && row.name === "admins") return "Can do everything";
  const labels = ordered(row).map((name) => permissionLabels[name]);
  return labels.length === 0 ? "No permissions" : labels.join(", ");
}

function toggle(perms: Permission[], permission: Permission, on: boolean) {
  return on ? [...perms, permission] : perms.filter((p) => p !== permission);
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
    const created = await client.groups.create({ name, permissions: perms });
    if (addName === name) addName = "";
    if (samePermissions(addPerms, perms)) addPerms = [];
    toast.success(`${created.name} created`);
    await list.reload();
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}

function startEdit(row: GroupRow) {
  editing = row;
  editPerms = [...row.permissions];
  editFailure = undefined;
  editOpen = true;
}

async function saveEdit() {
  const row = editing;
  if (!row) return;
  editBusy = true;
  editFailure = undefined;
  const perms = [...editPerms];
  try {
    const saved = await client.groups.setPermissions({
      id: row.id,
      permissions: perms,
    });
    if (list.data)
      list.set(
        list.data.map((group) => (group.id === saved.id ? saved : group)),
      );
    if (editing?.id === row.id && samePermissions(editPerms, perms)) {
      editOpen = false;
      editing = undefined;
    }
    toast.success(`${row.name} saved`);
    await list.reload();
  } catch (error) {
    if (editing?.id === row.id) editFailure = readFailure(error);
  } finally {
    editBusy = false;
  }
}
</script>

<AdminPage title="Groups">
  <FormGroup
    loading={list.data === undefined && !list.failure ? 3 : undefined}
    failure={list.failure ?? undefined}
    description="Admins and users are built in and can't be edited. Admins can do everything, and every new account joins users.{adminLocked
      ? ' Only an admin can change groups.'
      : ''}"
  >
    {#each list.data ?? [] as row (row.id)}
      <ListRow title={row.name} caption={caption(row)}>
        {#if row.builtIn}
          <Badge variant="outline">Built in</Badge>
        {:else}
          <Button
            variant="ghost"
            size="sm"
            disabled={adminLocked}
            onclick={() => startEdit(row)}>Edit</Button
          >
        {/if}
      </ListRow>
    {/each}
    {#snippet actions()}
      {#if list.failure}
        <Button
          variant="secondary"
          onclick={() => list.reload()}
          disabled={list.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  {#if !denied}
    <FormGroup
      title="New group"
      onsubmit={addGroup}
      failure={addFailure}
    >
      <FormRow label="Name" for="addName">
        <Input
          id="addName"
          name="name"
          required
          bind:value={addName}
          disabled={adminLocked}
        />
      </FormRow>
      {#each permissionNames as permission (permission)}
        <FormRow
          label={permissionLabels[permission]}
          for="add-{permission}"
          inline
        >
          <Switch
            id="add-{permission}"
            checked={addPerms.includes(permission)}
            onCheckedChange={(on) =>
              (addPerms = toggle(addPerms, permission, on))}
            disabled={adminLocked}
          />
        </FormRow>
      {/each}
      {#snippet actions()}
        <Button type="submit" disabled={addBusy || adminLocked}
          >Create group</Button
        >
      {/snippet}
    </FormGroup>
  {/if}
</AdminPage>

<Dialog.Root bind:open={editOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Edit {editing?.name}</Dialog.Title>
    </Dialog.Header>
    <div class="rounded-lg bg-elevated">
      {#each permissionNames as permission (permission)}
        <FormRow
          label={permissionLabels[permission]}
          for="edit-{editing?.id}-{permission}"
          inline
        >
          <Switch
            id="edit-{editing?.id}-{permission}"
            checked={editPerms.includes(permission)}
            onCheckedChange={(on) =>
              (editPerms = toggle(editPerms, permission, on))}
          />
        </FormRow>
      {/each}
    </div>
    {#if editFailure}
      <Failure failure={editFailure} />
    {/if}
    <Dialog.Footer>
      <Button variant="secondary" onclick={() => (editOpen = false)}
        >Cancel</Button
      >
      <Button onclick={saveEdit} disabled={editBusy}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
