<script lang="ts">
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { goto, invalidateAll } from "$app/navigation";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import { fromMbps, toMbps } from "$lib/bitrate.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
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

const id = $derived(page.params.id ?? "");

const access = resource(() => client.users.get({ id }));
const groups = resource(() => client.groups.list());
const libs = resource(() => client.libraries.list());
const sessions = resource(() => client.users.sessions({ id }));

let loadedId = untrack(() => id);
$effect(() => {
  if (id === loadedId) return;
  loadedId = id;
  resetRouteState();
  access.clear();
  sessions.clear();
  const target = id;
  const generation = routeGeneration;
  void serial(target, async () => {
    if (!currentVisit(target, generation)) return;
    await Promise.all([access.reload(), sessions.reload()]);
  });
});

type FailureShape = ReturnType<typeof readFailure>;
type SessionRow = NonNullable<typeof sessions.data>[number];

const instant = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const at = (value: string | null) =>
  value === null ? "Never" : instant.format(new Date(value));

function sessionState(session: SessionRow): string {
  if (session.revokedAt !== null) return "Revoked";
  const expires = session.expiresAt;
  if (expires !== null && new Date(expires).getTime() <= Date.now())
    return "Expired";
  return "Live";
}

function sessionTitle(session: SessionRow): string {
  if (session.clientName === null) return "Unknown app";
  if (session.deviceName === null) return session.clientName;
  return `${session.clientName} on ${session.deviceName}`;
}

let capInput = $state<string | null>(null);
let ratingInput = $state<string | null>(null);
let settingsBusy = $state(false);
let settingsFailure = $state<FailureShape | undefined>(undefined);

let groupSel = $state<Record<string, boolean>>({});
let groupsBusy = $state(false);
let groupsFailure = $state<FailureShape | undefined>(undefined);
let leaveAdminsOpen = $state(false);
let leaveConfirmed = $state(false);
let leaveGroupId = $state("");

let overrideSel = $state<Record<string, string>>({});
let overrideBusy = $state<Record<string, boolean>>({});
let overrideFailures = $state<Record<string, FailureShape>>({});

let accessSel = $state<Record<string, string>>({});
let libraryBusy = $state<Record<string, boolean>>({});
let libraryFailures = $state<Record<string, FailureShape>>({});

let revoking = $state<Record<string, boolean>>({});
let revokeFailures = $state<Record<string, FailureShape>>({});

let routeGeneration = 0;
const queues = new Map<string, Promise<unknown>>();

/** Orders writes to one user so the last answer is the last word. */
function serial<T>(target: string, run: () => Promise<T>) {
  const previous = queues.get(target) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(
    target,
    next.catch(() => {}),
  );
  return next;
}

function currentVisit(target: string, generation: number) {
  return target === id && generation === routeGeneration;
}

function resetRouteState() {
  routeGeneration += 1;
  capInput = null;
  ratingInput = null;
  settingsFailure = undefined;
  settingsBusy = false;
  groupSel = {};
  groupsFailure = undefined;
  groupsBusy = false;
  leaveAdminsOpen = false;
  leaveConfirmed = false;
  leaveGroupId = "";
  overrideSel = {};
  overrideBusy = {};
  overrideFailures = {};
  accessSel = {};
  libraryBusy = {};
  libraryFailures = {};
  revoking = {};
  revokeFailures = {};
}

const capValue = $derived(
  capInput ??
    (access.data?.settings.bitrateCapBps == null
      ? ""
      : toMbps(access.data.settings.bitrateCapBps)),
);
const ratingValue = $derived(
  ratingInput ?? access.data?.settings.contentRatingCeiling ?? "",
);
const groupsLocked = $derived(
  access.data !== undefined && access.data.user.disabledAt !== null,
);
const adminLocked = $derived(!data.me.admin);
const displayName = $derived(access.data?.user.displayName ?? "User");

async function saveSettings(event: SubmitEvent) {
  const target = id;
  const generation = routeGeneration;
  event.preventDefault();
  settingsBusy = true;
  settingsFailure = undefined;
  try {
    const submittedCap = capValue;
    const submittedRating = ratingValue;
    const capNumber = fromMbps(submittedCap);
    if (capNumber === undefined) {
      settingsFailure = {
        code: "BAD_REQUEST",
        message: "The bitrate cap must be a positive number of Mbit/s.",
      };
      return;
    }
    const rating = submittedRating.trim();
    const updated = await serial(target, () =>
      client.users.setSettings({
        id: target,
        bitrateCapBps: capNumber,
        contentRatingCeiling: rating === "" ? null : rating,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
    if (capInput === submittedCap) capInput = null;
    if (ratingInput === submittedRating) ratingInput = null;
    toast.success("Playback limits saved");
  } catch (error) {
    if (currentVisit(target, generation)) settingsFailure = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) settingsBusy = false;
  }
}

async function saveGroups(
  groupIds: string[],
  groupName: string,
  added: boolean,
) {
  const target = id;
  const generation = routeGeneration;
  groupsBusy = true;
  groupsFailure = undefined;
  try {
    const updated = await serial(target, () =>
      client.users.setGroups({
        id: target,
        groupIds,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
    toast.success(
      `${updated.user.displayName} ${added ? "added to" : "removed from"} ${groupName}`,
    );
    if (target === data.me.user.id) {
      await invalidateAll();
      await serial(target, async () => {
        if (!currentVisit(target, generation)) return;
        await Promise.all([
          access.reload(),
          sessions.reload(),
          groups.reload(),
          libs.reload(),
        ]);
      });
    }
  } catch (error) {
    if (currentVisit(target, generation)) groupsFailure = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) {
      groupSel = {};
      groupsBusy = false;
    }
  }
}

type GroupRow = NonNullable<typeof groups.data>[number];

function groupChecked(group: GroupRow): boolean {
  return (
    groupSel[group.id] ?? access.data?.groupIds.includes(group.id) ?? false
  );
}

function toggleGroup(group: GroupRow, checked: boolean) {
  groupSel[group.id] = checked;
  const self = id === data.me.user.id;
  if (self && !checked && group.builtIn && group.name === "admins") {
    leaveGroupId = group.id;
    leaveAdminsOpen = true;
    return;
  }
  const next = checked
    ? [...(access.data?.groupIds ?? []), group.id]
    : (access.data?.groupIds ?? []).filter((one) => one !== group.id);
  void saveGroups(next, group.name, checked);
}

async function leaveAdmins() {
  const admins = (groups.data ?? []).find(
    (group) => group.builtIn && group.name === "admins",
  );
  if (!admins) return;
  leaveConfirmed = true;
  const next = (access.data?.groupIds ?? []).filter((one) => one !== admins.id);
  await saveGroups(next, admins.name, false);
  leaveConfirmed = false;
}

function revertLeave() {
  if (!leaveConfirmed) delete groupSel[leaveGroupId];
}

function overrideValue(permission: string): string {
  const row = access.data?.overrides.find(
    (entry) => entry.permission === permission,
  );
  if (!row) return "inherit";
  return row.allowed ? "allow" : "deny";
}

const overrideOptions = [
  { value: "inherit", label: "From groups" },
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Deny" },
];

async function setOverride(permission: Permission, value: string) {
  const target = id;
  const generation = routeGeneration;
  overrideSel[permission] = value;
  overrideBusy[permission] = true;
  delete overrideFailures[permission];
  try {
    const updated = await serial(target, () =>
      client.users.setOverride({
        id: target,
        permission,
        allowed: value === "allow" ? true : value === "deny" ? false : null,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
    delete overrideSel[permission];
    toast.success(
      value === "allow"
        ? `${permissionLabels[permission]} allowed`
        : value === "deny"
          ? `${permissionLabels[permission]} denied`
          : `${permissionLabels[permission]} now follows groups`,
    );
  } catch (error) {
    if (currentVisit(target, generation)) {
      overrideFailures[permission] = readFailure(error);
      delete overrideSel[permission];
    }
  } finally {
    if (currentVisit(target, generation)) overrideBusy[permission] = false;
  }
}

function accessValue(libraryId: string): string {
  const row = access.data?.libraryAccess.find(
    (entry) => entry.libraryId === libraryId,
  );
  if (!row) return "inherit";
  return row.allowed ? "allow" : "deny";
}

async function setAccess(libraryId: string, value: string) {
  const target = id;
  const generation = routeGeneration;
  const name =
    (libs.data ?? []).find((library) => library.id === libraryId)?.name ??
    "library";
  accessSel[libraryId] = value;
  libraryBusy[libraryId] = true;
  delete libraryFailures[libraryId];
  try {
    const updated = await serial(target, () =>
      client.users.setLibraryAccess({
        id: target,
        libraryId,
        allowed: value === "allow" ? true : value === "deny" ? false : null,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
    delete accessSel[libraryId];
    toast.success(
      value === "allow"
        ? `${name} allowed`
        : value === "deny"
          ? `${name} denied`
          : `${name} now follows groups`,
    );
  } catch (error) {
    if (currentVisit(target, generation)) {
      libraryFailures[libraryId] = readFailure(error);
      delete accessSel[libraryId];
    }
  } finally {
    if (currentVisit(target, generation)) libraryBusy[libraryId] = false;
  }
}

async function revoke(sessionId: string) {
  const target = id;
  const generation = routeGeneration;
  revoking[sessionId] = true;
  delete revokeFailures[sessionId];
  try {
    await serial(target, () => client.users.revokeSession({ id: sessionId }));
    if (!currentVisit(target, generation)) return;
    await sessions.reload();
    if (!currentVisit(target, generation)) return;
    if (sessions.failure?.code === "UNAUTHORIZED") await goto("/login");
    else toast.success("Session revoked");
  } catch (error) {
    if (currentVisit(target, generation))
      revokeFailures[sessionId] = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) revoking[sessionId] = false;
  }
}
</script>

<AdminPage
  title={displayName}
  parent={{ href: "/admin/users", label: "Users" }}
>
  <FormGroup
    title="Account"
    loading={access.data === undefined && !access.failure ? 4 : undefined}
    failure={access.failure ?? undefined}
  >
    {#if access.data}
      <FormRow label="Username" inline>
        <span class="text-subheadline text-label-secondary"
          >{access.data.user.username}</span
        >
      </FormRow>
      <FormRow label="Email" inline>
        <span class="text-subheadline text-label-secondary"
          >{access.data.user.email ?? "Not set"}</span
        >
      </FormRow>
      <FormRow label="Created" inline>
        <span class="text-subheadline text-label-secondary"
          >{at(access.data.user.createdAt)}</span
        >
      </FormRow>
      <FormRow label="Status" inline>
        <span class="text-subheadline text-label-secondary"
          >{access.data.user.disabledAt === null ? "Active" : "Disabled"}</span
        >
      </FormRow>
    {/if}
    {#snippet actions()}
      {#if access.failure}
        <Button
          variant="secondary"
          onclick={() => access.reload()}
          disabled={access.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Sessions"
    loading={sessions.data === undefined && !sessions.failure ? 2 : undefined}
    failure={sessions.failure ??
      (Object.values(revokeFailures).at(-1) || undefined)}
  >
    {#each sessions.data ?? [] as session (session.id)}
      {@const state = sessionState(session)}
      <ListRow
        title={sessionTitle(session)}
        caption="{session.lastSeenAt === null
          ? 'Not seen yet'
          : `Last seen ${at(session.lastSeenAt)}`} · {session.expiresAt ===
        null
          ? "Doesn't expire"
          : `Expires ${at(session.expiresAt)}`}"
      >
        {#if state === "Live"}
          <ConfirmDialog
            title="Revoke this session?"
            description="{sessionTitle(session)} is signed out and has to sign in again."
            action="Revoke session"
            onconfirm={() => revoke(session.id)}
          >
            {#snippet trigger(props)}
              <Button
                {...props}
                variant="ghost"
                size="sm"
                class="text-destructive"
                disabled={revoking[session.id] === true}>Revoke</Button
              >
            {/snippet}
          </ConfirmDialog>
        {:else}
          <Badge>{state}</Badge>
        {/if}
      </ListRow>
    {:else}
      {#if sessions.data !== undefined}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No sessions.</span
          >
        </div>
      {/if}
    {/each}
    {#snippet actions()}
      {#if sessions.failure}
        <Button
          variant="secondary"
          onclick={() => sessions.reload()}
          disabled={sessions.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Playback limits"
    onsubmit={saveSettings}
    failure={settingsFailure}
    description="Leave a field empty for no limit."
  >
    <FormRow label="Bitrate cap" for="bitrateCap">
      <div class="flex items-center gap-3">
        <Input
          id="bitrateCap"
          name="bitrateCap"
          type="number"
          min="0"
          step="any"
          inputmode="decimal"
          class="w-32"
          value={capValue}
          oninput={(event) => (capInput = event.currentTarget.value)}
          disabled={!access.data}
        />
        <span class="text-subheadline text-label-secondary">Mbit/s</span>
      </div>
    </FormRow>
    <FormRow label="Content rating ceiling" for="ratingCeiling">
      <Input
        id="ratingCeiling"
        name="ratingCeiling"
        class="w-32"
        value={ratingValue}
        oninput={(event) => (ratingInput = event.currentTarget.value)}
        disabled={!access.data}
      />
    </FormRow>
    {#snippet actions()}
      <Button type="submit" disabled={settingsBusy || !access.data}>Save</Button
      >
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Groups"
    loading={groups.data === undefined && !groups.failure ? 3 : undefined}
    failure={groups.failure ?? groupsFailure}
    description="{groupsLocked
      ? "Group membership can't change while the account is disabled."
      : ''}{adminLocked ? 'Only an admin can change this.' : ''}"
  >
    {#each groups.data ?? [] as group (group.id)}
      <FormRow label={group.name} for="group-{group.id}" inline>
        <Switch
          id="group-{group.id}"
          checked={groupChecked(group)}
          onCheckedChange={(checked) => toggleGroup(group, checked)}
          disabled={groupsBusy || !access.data || groupsLocked || adminLocked}
        />
        {#if group.builtIn}
          <Badge variant="outline">Built in</Badge>
        {/if}
      </FormRow>
    {/each}
    {#snippet actions()}
      {#if groups.failure}
        <Button
          variant="secondary"
          onclick={() => groups.reload()}
          disabled={groups.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Permissions"
    failure={Object.values(overrideFailures).at(-1) || undefined}
    description="From groups follows this user's groups. Allow and Deny override them.{adminLocked
      ? ' Only an admin can change this.'
      : ''}"
  >
    {#each permissionNames as permission (permission)}
      {@const value = overrideSel[permission] ?? overrideValue(permission)}
      <FormRow
        label={permissionLabels[permission]}
        for="override-{permission}"
        inline
      >
        <Select.Root
          type="single"
          {value}
          onValueChange={(next) => setOverride(permission, next)}
          disabled={overrideBusy[permission] === true ||
            !access.data ||
            adminLocked}
        >
          <Select.Trigger id="override-{permission}">
            <Select.Value
              >{overrideOptions.find((o) => o.value === value)
                ?.label}</Select.Value
            >
          </Select.Trigger>
          <Select.Content>
            {#each overrideOptions as option (option.value)}
              <Select.Item value={option.value}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </FormRow>
    {/each}
  </FormGroup>

  <FormGroup
    title="Library access"
    loading={libs.data === undefined && !libs.failure ? 3 : undefined}
    failure={libs.failure ??
      (Object.values(libraryFailures).at(-1) || undefined)}
    description="Deny wins over every group.{adminLocked
      ? ' Only an admin can change this.'
      : ''}"
  >
    {#each libs.data ?? [] as library (library.id)}
      {@const value = accessSel[library.id] ?? accessValue(library.id)}
      <FormRow label={library.name} for="access-{library.id}" inline>
        <Select.Root
          type="single"
          {value}
          onValueChange={(next) => setAccess(library.id, next)}
          disabled={libraryBusy[library.id] === true ||
            !access.data ||
            adminLocked}
        >
          <Select.Trigger id="access-{library.id}">
            <Select.Value
              >{overrideOptions.find((o) => o.value === value)
                ?.label}</Select.Value
            >
          </Select.Trigger>
          <Select.Content>
            {#each overrideOptions as option (option.value)}
              <Select.Item value={option.value}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </FormRow>
    {:else}
      {#if libs.data !== undefined}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No libraries yet.</span
          >
        </div>
      {/if}
    {/each}
  </FormGroup>
</AdminPage>

<ConfirmDialog
  bind:open={leaveAdminsOpen}
  title="Leave the admins group?"
  description="You lose access to these settings as soon as you leave."
  action="Leave group"
  onconfirm={leaveAdmins}
  onclosed={revertLeave}
/>
