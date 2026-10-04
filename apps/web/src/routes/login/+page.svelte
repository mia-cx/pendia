<script lang="ts">
import { goto } from "$app/navigation";
import { signIn } from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import OidcSignIn from "$lib/components/OidcSignIn.svelte";
import { readFailure } from "$lib/errors.ts";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();

let username = $state("");
let password = $state("");
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

const provider = $derived(data.oidc?.name ?? "SSO");

// The OIDC routes send the browser back here with a lowercased auth error code.
function oidcMessage(code: string) {
  if (code === "oidc_failed")
    return `Sign-in with ${provider} did not work. Try again, or open your invite link if you are new here.`;
  if (code === "invalid_invite")
    return "That invite is used or expired. Ask for a new one.";
  if (code === "not_found")
    return `Sign-in with ${provider} is not set up on this server.`;
  return `Sign-in with ${provider} failed on the server. Try again.`;
}

let passwordTried = $state(false);
const oidcFailure = $derived(
  data.error === null || passwordTried
    ? undefined
    : { code: "UNAUTHORIZED" as const, message: oidcMessage(data.error) },
);
const shown = $derived(failure ?? oidcFailure);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  passwordTried = true;
  failure = undefined;
  try {
    await signIn({ username, password });
    await goto("/");
  } catch (error) {
    failure = readFailure(error);
    busy = false;
  }
}
</script>

<svelte:head>
  <title>Sign in · Pendia</title>
</svelte:head>

<main>
  <h1>Sign in</h1>
  {#if shown}
    <Failure failure={shown} />
  {/if}
  <form onsubmit={submit}>
    <label for="username">Username</label>
    <input
      id="username"
      name="username"
      autocomplete="username"
      required
      bind:value={username}
    />
    <label for="password">Password</label>
    <input
      id="password"
      name="password"
      type="password"
      autocomplete="current-password"
      required
      bind:value={password}
    />
    <button type="submit" disabled={busy}>Sign in</button>
  </form>
  {#if data.oidc}
    <div class="oidc">
      <OidcSignIn name={data.oidc.name} />
    </div>
  {/if}
</main>

<style>
  main {
    display: grid;
    min-height: 100svh;
    align-content: center;
    justify-items: center;
    padding: 32px;
  }

  h1 {
    margin: 0 0 24px;
  }

  main :global(.failure) {
    width: 100%;
    max-width: 320px;
    margin-bottom: 16px;
  }

  form {
    display: grid;
    width: 100%;
    max-width: 320px;
    gap: 8px;
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
