<script lang="ts">
import { goto } from "$app/navigation";
import {
  acceptInvite,
  type InviteStatus,
  readInviteStatus,
} from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import OidcSignIn from "$lib/components/OidcSignIn.svelte";
import { AuthRouteError, readFailure } from "$lib/errors.ts";
import type { PageProps } from "./$types";

const { data, params }: PageProps = $props();

let username = $state("");
let displayName = $state("");
let password = $state("");
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let reread = $state<InviteStatus | undefined>(undefined);

const status = $derived(reread ?? data.status);

// The accept route answers these two with server wording meant for developers.
function acceptFailure(error: unknown) {
  const read = readFailure(error);
  if (read.code === "CONFLICT")
    return {
      ...read,
      message: "An account already uses that username or this invite's email.",
    };
  if (read.code === "BAD_REQUEST")
    return {
      ...read,
      message:
        "A username uses letters, digits, dots, underscores and hyphens, and starts with a letter or digit.",
    };
  return read;
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  failure = undefined;
  try {
    await acceptInvite({
      token: params.token,
      username,
      password,
      displayName: displayName.trim() === "" ? undefined : displayName,
    });
    await goto("/");
  } catch (error) {
    try {
      if (error instanceof AuthRouteError && error.code === "INVALID_INVITE")
        reread = (await readInviteStatus(params.token)).status;
      else failure = acceptFailure(error);
    } catch (statusError) {
      failure = readFailure(statusError);
    }
    busy = false;
  }
}
</script>

<svelte:head>
  <title>Join Pendia</title>
</svelte:head>

<main>
  {#if status === "live"}
    <h1>Create your account</h1>
    {#if failure}
      <Failure {failure} />
    {/if}
    <form onsubmit={submit}>
      <label for="username">Username</label>
      <input
        id="username"
        name="username"
        autocomplete="username"
        maxlength="64"
        required
        bind:value={username}
      />
      <label for="displayName">Display name</label>
      <input
        id="displayName"
        name="displayName"
        autocomplete="name"
        maxlength="128"
        bind:value={displayName}
      />
      <label for="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autocomplete="new-password"
        maxlength="1024"
        required
        bind:value={password}
      />
      <button type="submit" disabled={busy}>Create account</button>
    </form>
    {#if data.oidc}
      <div class="oidc">
        <OidcSignIn name={data.oidc.name} invite={params.token} />
      </div>
    {/if}
  {:else if status === "expired"}
    <h1>This invite has expired</h1>
    <p class="muted">Ask the person who invited you for a new one.</p>
  {:else if status === "accepted"}
    <h1>This invite is already used</h1>
    <p class="muted">It created an account. <a href="/login">Sign in</a></p>
  {:else}
    <h1>This invite does not exist</h1>
    <p class="muted">
      Check that you copied the whole link, or ask for a new invite.
    </p>
  {/if}
</main>

<style>
  main {
    display: grid;
    min-height: 100svh;
    align-content: center;
    justify-items: center;
    padding: 32px;
    text-align: center;
  }

  h1 {
    margin: 0 0 24px;
  }

  p {
    max-width: 320px;
    margin: -8px 0 0;
  }

  a {
    color: var(--signal);
  }

  main :global(.failure) {
    width: 100%;
    max-width: 320px;
    margin-bottom: 16px;
    text-align: left;
  }

  form {
    display: grid;
    width: 100%;
    max-width: 320px;
    gap: 8px;
    text-align: left;
  }

  form button {
    margin-top: 8px;
  }

  .oidc {
    width: 100%;
    max-width: 320px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
</style>
