<script lang="ts">
import { client } from "$lib/api.ts";
import { createInvite } from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";

const list = resource(() => client.users.list());

type InviteResult = Awaited<ReturnType<typeof createInvite>>;

const instant = (value: string) => new Date(value).toLocaleString();

let addUsername = $state("");
let addPassword = $state("");
let addDisplayName = $state("");
let addBusy = $state(false);
let addFailure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

let inviteEmail = $state("");
let inviteDays = $state("7");
let inviteBusy = $state(false);
let inviteFailure = $state<ReturnType<typeof readFailure> | undefined>(
  undefined,
);
let inviteResult = $state<InviteResult | undefined>(undefined);

async function addUser(event: SubmitEvent) {
  event.preventDefault();
  addBusy = true;
  addFailure = undefined;
  try {
    await client.users.create({
      username: addUsername,
      password: addPassword,
      displayName: addDisplayName.trim() === "" ? undefined : addDisplayName,
    });
    addUsername = "";
    addPassword = "";
    addDisplayName = "";
    await list.reload();
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}

async function sendInvite(event: SubmitEvent) {
  event.preventDefault();
  inviteBusy = true;
  inviteFailure = undefined;
  inviteResult = undefined;
  try {
    inviteResult = await createInvite({
      email: inviteEmail,
      expiresInSeconds: Number(inviteDays) * 86_400,
    });
    inviteEmail = "";
  } catch (error) {
    inviteFailure = readFailure(error);
  } finally {
    inviteBusy = false;
  }
}
</script>

<svelte:head>
  <title>Users · Pendia admin</title>
</svelte:head>

<h2>Users</h2>

{#if list.failure}
  <Failure failure={list.failure} />
{:else}
  <table>
    <thead>
      <tr>
        <th>Username</th>
        <th>Display name</th>
        <th>Email</th>
        <th>Created</th>
        <th>Status</th>
        <th><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {#each list.data ?? [] as row (row.id)}
        <tr>
          <td>{row.username}</td>
          <td>{row.displayName}</td>
          <td>{row.email ?? "Not set"}</td>
          <td>{instant(row.createdAt)}</td>
          <td>{row.disabledAt === null ? "Enabled" : "Disabled"}</td>
          <td><a href={`/admin/users/${row.id}`}>Manage</a></td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<div class="forms">
  <form onsubmit={addUser}>
    <h3>Create a user</h3>
    <p class="muted">A new account joins the built-in users group.</p>
    {#if addFailure}
      <Failure failure={addFailure} />
    {/if}
    <label for="addUsername">Username</label>
    <input
      id="addUsername"
      name="username"
      autocomplete="off"
      required
      bind:value={addUsername}
    />
    <label for="addPassword">Password</label>
    <input
      id="addPassword"
      name="password"
      type="password"
      autocomplete="new-password"
      required
      bind:value={addPassword}
    />
    <label for="addDisplayName">Display name</label>
    <input
      id="addDisplayName"
      name="displayName"
      bind:value={addDisplayName}
    />
    <button type="submit" disabled={addBusy}>Create user</button>
  </form>

  <form onsubmit={sendInvite}>
    <h3>Invite a user</h3>
    {#if inviteFailure}
      <Failure failure={inviteFailure} />
    {/if}
    <label for="inviteEmail">Email</label>
    <input
      id="inviteEmail"
      name="email"
      type="email"
      required
      bind:value={inviteEmail}
    />
    <label for="inviteDays">Expires after</label>
    <select id="inviteDays" name="expires" bind:value={inviteDays}>
      <option value="1">1 day</option>
      <option value="7">7 days</option>
      <option value="30">30 days</option>
    </select>
    <button type="submit" disabled={inviteBusy}>Create invite</button>
    {#if inviteResult}
      <div class="token">
        <p class="muted">
          Copy this token now. It is shown once and cannot be read again.
        </p>
        <input
          readonly
          value={inviteResult.token}
          aria-label="Invite token"
          onclick={(event) => event.currentTarget.select()}
        />
        <p class="muted">
          For {inviteResult.invite.email}, expires {instant(
            inviteResult.invite.expiresAt,
          )}.
        </p>
      </div>
    {/if}
  </form>
</div>

<style>
.forms {
  display: flex;
  flex-wrap: wrap;
  gap: 48px;
  margin-top: 32px;
}

form {
  display: grid;
  width: 100%;
  max-width: 360px;
  gap: 8px;
  align-content: start;
}

form h3,
form p {
  margin: 0 0 4px;
}

form :global(.failure) {
  margin-bottom: 4px;
}

.token {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

.token input {
  width: 100%;
  font-family: ui-monospace, monospace;
}
</style>
