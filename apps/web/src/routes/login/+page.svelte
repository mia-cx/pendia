<script lang="ts">
import { goto } from "$app/navigation";
import { signIn } from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import "$lib/admin.css";

let username = $state("");
let password = $state("");
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  failure = undefined;
  try {
    await signIn({ username, password });
    await goto("/admin");
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
  {#if failure}
    <Failure {failure} />
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
</style>
