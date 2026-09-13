<script lang="ts">
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { type Permission, permissionNames } from "$lib/permissions.ts";
import { resource } from "$lib/resource.svelte.ts";

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
  void access.reload();
  void sessions.reload();
});

type FailureShape = ReturnType<typeof readFailure>;

const instant = (value: string | null) =>
  value === null ? "Never" : new Date(value).toLocaleString();

let capInput = $state<string | null>(null);
let ratingInput = $state<string | null>(null);
let settingsBusy = $state(false);
let settingsFailure = $state<FailureShape | undefined>(undefined);

let groupSel = $state<Record<string, boolean>>({});
let groupsBusy = $state(false);
let groupsFailure = $state<FailureShape | undefined>(undefined);

let overrideBusy = $state<Record<string, boolean>>({});
let overrideFailures = $state<Record<string, FailureShape>>({});

let libraryBusy = $state<Record<string, boolean>>({});
let libraryFailures = $state<Record<string, FailureShape>>({});

let revoking = $state<Record<string, boolean>>({});
let revokeFailures = $state<Record<string, FailureShape>>({});

let routeGeneration = 0;
let pending: Promise<unknown> = Promise.resolve();

function serial<T>(run: () => Promise<T>) {
  const next = pending.then(run, run);
  pending = next.catch(() => {});
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
  overrideBusy = {};
  overrideFailures = {};
  libraryBusy = {};
  libraryFailures = {};
  revoking = {};
  revokeFailures = {};
}

const capValue = $derived(
  capInput ?? String(access.data?.settings.bitrateCapBps ?? ""),
);
const ratingValue = $derived(
  ratingInput ?? access.data?.settings.contentRatingCeiling ?? "",
);

async function saveSettings(event: SubmitEvent) {
  const target = id;
  const generation = routeGeneration;
  event.preventDefault();
  settingsBusy = true;
  settingsFailure = undefined;
  try {
    const submittedCap = capValue;
    const submittedRating = ratingValue;
    const cap = submittedCap.trim();
    const capNumber = cap === "" ? null : Number(cap);
    if (
      capNumber !== null &&
      (!Number.isSafeInteger(capNumber) || capNumber < 1)
    ) {
      settingsFailure = {
        code: "BAD_REQUEST",
        message: "The bitrate cap must be a whole number of bits per second.",
      };
      return;
    }
    const rating = submittedRating.trim();
    const updated = await serial(() =>
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
  } catch (error) {
    if (currentVisit(target, generation)) settingsFailure = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) settingsBusy = false;
  }
}

async function saveGroups() {
  const target = id;
  const generation = routeGeneration;
  groupsBusy = true;
  groupsFailure = undefined;
  try {
    const checked = (groups.data ?? [])
      .filter(
        (group) =>
          groupSel[group.id] ??
          access.data?.groupIds.includes(group.id) ??
          false,
      )
      .map((group) => group.id);
    const updated = await serial(() =>
      client.users.setGroups({
        id: target,
        groupIds: checked,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
    groupSel = {};
  } catch (error) {
    if (currentVisit(target, generation)) groupsFailure = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) groupsBusy = false;
  }
}

function overrideValue(permission: string): string {
  const row = access.data?.overrides.find(
    (entry) => entry.permission === permission,
  );
  if (!row) return "inherit";
  return row.allowed ? "allow" : "deny";
}

async function setOverride(permission: Permission, value: string) {
  const target = id;
  const generation = routeGeneration;
  overrideBusy[permission] = true;
  delete overrideFailures[permission];
  try {
    const updated = await serial(() =>
      client.users.setOverride({
        id: target,
        permission,
        allowed: value === "allow" ? true : value === "deny" ? false : null,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
  } catch (error) {
    if (currentVisit(target, generation))
      overrideFailures[permission] = readFailure(error);
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
  libraryBusy[libraryId] = true;
  delete libraryFailures[libraryId];
  try {
    const updated = await serial(() =>
      client.users.setLibraryAccess({
        id: target,
        libraryId,
        allowed: value === "allow" ? true : value === "deny" ? false : null,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
  } catch (error) {
    if (currentVisit(target, generation))
      libraryFailures[libraryId] = readFailure(error);
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
    await serial(() => client.users.revokeSession({ id: sessionId }));
    if (!currentVisit(target, generation)) return;
    await sessions.reload();
    if (!currentVisit(target, generation)) return;
    if (sessions.failure?.code === "UNAUTHORIZED") await goto("/login");
  } catch (error) {
    if (currentVisit(target, generation))
      revokeFailures[sessionId] = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) revoking[sessionId] = false;
  }
}
</script>

<svelte:head>
  <title>{access.data?.user.displayName ?? "User"} · Pendia admin</title>
</svelte:head>

<p><a href="/admin/users">Users</a></p>
<h2>{access.data?.user.displayName ?? "User"}</h2>

<section>
  <h3>Account</h3>
  {#if access.failure}
    <Failure failure={access.failure} />
    <button
      type="button"
      onclick={() => access.reload()}
      disabled={access.loading}>Retry</button
    >
  {:else if access.data}
    <dl class="facts">
      <div><dt>Username</dt><dd>{access.data.user.username}</dd></div>
      <div>
        <dt>Display name</dt><dd>{access.data.user.displayName}</dd>
      </div>
      <div>
        <dt>Email</dt><dd>{access.data.user.email ?? "Not set"}</dd>
      </div>
      <div>
        <dt>Created</dt><dd>{instant(access.data.user.createdAt)}</dd>
      </div>
      <div>
        <dt>Status</dt><dd>
          {access.data.user.disabledAt === null ? "Enabled" : "Disabled"}
        </dd>
      </div>
    </dl>
  {:else}
    <p class="muted">Loading.</p>
  {/if}
</section>

<section>
  <h3>Sessions</h3>
  {#if sessions.failure}
    <Failure failure={sessions.failure} />
    <button
      type="button"
      onclick={() => sessions.reload()}
      disabled={sessions.loading}>Retry</button
    >
  {:else}
    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th>Device</th>
          <th>Created</th>
          <th>Last seen</th>
          <th>Expires</th>
          <th>State</th>
          <th><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each sessions.data ?? [] as session (session.id)}
          <tr>
            <td>{session.clientName}</td>
            <td>{session.deviceName}</td>
            <td>{instant(session.createdAt)}</td>
            <td>{instant(session.lastSeenAt)}</td>
            <td>{instant(session.expiresAt)}</td>
            <td>{session.revokedAt === null ? "Live" : "Revoked"}</td>
            <td>
              {#if session.revokedAt === null}
                <button
                  type="button"
                  onclick={() => revoke(session.id)}
                  disabled={revoking[session.id] === true}>Revoke</button
                >
                {#if revokeFailures[session.id]}
                  <Failure failure={revokeFailures[session.id]} />
                {/if}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<section>
  <h3>Playback caps</h3>
  {#if access.failure}
    <Failure failure={access.failure} />
    <button
      type="button"
      onclick={() => access.reload()}
      disabled={access.loading}>Retry</button
    >
  {:else}
    <form onsubmit={saveSettings} class="settings">
      {#if settingsFailure}
        <Failure failure={settingsFailure} />
      {/if}
      <label for="bitrateCap">Bitrate cap in bits per second</label>
      <input
        id="bitrateCap"
        name="bitrateCap"
        type="number"
        min="1"
        inputmode="numeric"
        value={capValue}
        oninput={(event) => (capInput = event.currentTarget.value)}
        disabled={!access.data}
      />
      <p class="muted">Leave this empty for no cap.</p>
      <label for="ratingCeiling">Content-rating ceiling</label>
      <input
        id="ratingCeiling"
        name="ratingCeiling"
        value={ratingValue}
        oninput={(event) => (ratingInput = event.currentTarget.value)}
        disabled={!access.data}
      />
      <p class="muted">Leave this empty for no ceiling.</p>
      <button type="submit" disabled={settingsBusy || !access.data}>Save</button
      >
    </form>
  {/if}
</section>

<section>
  <h3>Groups</h3>
  {#if groups.failure}
    <Failure failure={groups.failure} />
    <button
      type="button"
      onclick={() => groups.reload()}
      disabled={groups.loading}>Retry</button
    >
  {:else if access.failure}
    <Failure failure={access.failure} />
    <button
      type="button"
      onclick={() => access.reload()}
      disabled={access.loading}>Retry</button
    >
  {:else}
    {#each groups.data ?? [] as group (group.id)}
      <div class="check">
        <input
          id={`group-${group.id}`}
          type="checkbox"
          checked={groupSel[group.id] ??
          access.data?.groupIds.includes(group.id) ??
          false}
          onchange={(event) =>
            (groupSel[group.id] = event.currentTarget.checked)}
          disabled={groupsBusy || !access.data}
        />
        <label for={`group-${group.id}`}
          >{group.name}{#if group.builtIn}
            <span class="muted">built in</span>{/if}</label
        >
      </div>
    {/each}
    {#if groupsFailure}
      <Failure failure={groupsFailure} />
    {/if}
    <button
      type="button"
      onclick={saveGroups}
      disabled={groupsBusy || !groups.data || !access.data}>Save</button
    >
  {/if}
</section>

<section>
  <h3>Permission overrides</h3>
  <p class="muted">A group grant applies when the override is Inherit.</p>
  {#if access.failure}
    <Failure failure={access.failure} />
    <button
      type="button"
      onclick={() => access.reload()}
      disabled={access.loading}>Retry</button
    >
  {:else}
    <table>
      <tbody>
        {#each permissionNames as permission (permission)}
          <tr>
            <td>{permission}</td>
            <td>
              <select
                aria-label={`Override for ${permission}`}
                value={overrideValue(permission)}
                onchange={(event) =>
                  setOverride(permission, event.currentTarget.value)}
                disabled={overrideBusy[permission] === true || !access.data}
              >
                <option value="inherit">Inherit</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
              {#if overrideFailures[permission]}
                <Failure failure={overrideFailures[permission]} />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<section>
  <h3>Library access</h3>
  <p class="muted">An explicit Deny wins over a group grant.</p>
  {#if libs.failure}
    <Failure failure={libs.failure} />
    <button
      type="button"
      onclick={() => libs.reload()}
      disabled={libs.loading}>Retry</button
    >
  {:else if access.failure}
    <Failure failure={access.failure} />
    <button
      type="button"
      onclick={() => access.reload()}
      disabled={access.loading}>Retry</button
    >
  {:else}
    <table>
      <tbody>
        {#each libs.data ?? [] as library (library.id)}
          <tr>
            <td>{library.name}</td>
            <td>
              <select
                aria-label={`Access for ${library.name}`}
                value={accessValue(library.id)}
                onchange={(event) =>
                  setAccess(library.id, event.currentTarget.value)}
                disabled={libraryBusy[library.id] === true || !access.data}
              >
                <option value="inherit">Inherit</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
              {#if libraryFailures[library.id]}
                <Failure failure={libraryFailures[library.id]} />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if (libs.data ?? []).length === 0}
      <p class="muted">No libraries to permit.</p>
    {/if}
  {/if}
</section>

<style>
section {
  max-width: 720px;
  margin-bottom: 32px;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 32px;
  margin: 0;
}

.facts div {
  display: grid;
  gap: 2px;
}

.facts dt {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.facts dd {
  margin: 0;
}

.settings {
  display: grid;
  max-width: 360px;
  gap: 8px;
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

.check .muted {
  font-size: 12px;
}

section :global(.failure) {
  margin: 8px 0;
}
</style>
