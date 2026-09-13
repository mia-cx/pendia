<script lang="ts">
import { goto } from "$app/navigation";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import {
  createAdmin,
  createFirstLibrary,
  type WizardSession,
  waitForScan,
} from "$lib/wizard.ts";
import "$lib/admin.css";

type ScanStatus = Awaited<ReturnType<typeof waitForScan>>;

const stepTitles = ["Create the admin", "Add the first library", "Scan"];

let step = $state(0);
let session = $state<WizardSession | undefined>(undefined);
let libraryId = $state("");
let status = $state<ScanStatus | undefined>(undefined);
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

let username = $state("");
let password = $state("");
let displayName = $state("");
let libraryName = $state("");
let rootPath = $state("");

const scanSettled = $derived(
  status !== undefined &&
    status.counts.queued === 0 &&
    status.counts.running === 0,
);
const scanFailed = $derived(
  scanSettled && status !== undefined && status.latest?.state === "failed",
);
const scanDone = $derived(
  scanSettled && status !== undefined && status.latest?.state === "completed",
);

async function submitAdmin(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  failure = undefined;
  try {
    session = await createAdmin({
      username,
      password,
      displayName: displayName.trim() === "" ? undefined : displayName,
    });
    step = 1;
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}

async function watchScan() {
  if (!session) return;
  status = await waitForScan(session, libraryId, {
    onStatus: (reading) => {
      status = reading;
    },
  });
}

async function submitLibrary(event: SubmitEvent) {
  event.preventDefault();
  if (!session) return;
  busy = true;
  failure = undefined;
  try {
    const created = await createFirstLibrary(session, {
      name: libraryName,
      rootPath,
    });
    libraryId = created.library.id;
    step = 2;
    await watchScan();
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}

async function rescan() {
  if (!session) return;
  busy = true;
  failure = undefined;
  try {
    await session.client.libraries.scan({ id: libraryId });
    await watchScan();
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}
</script>

<svelte:head>
  <title>Set up Pendia</title>
</svelte:head>

<main>
  <h1>Set up Pendia</h1>

  <ol class="steps">
    {#each stepTitles as title, index (title)}
      <li aria-current={index === step ? "step" : undefined}>
        <span class="marker">{index < step ? "Done" : `Step ${index + 1}`}</span>
        {title}
      </li>
    {/each}
  </ol>

  <section class="panel">
    {#if step === 0}
      <form onsubmit={submitAdmin}>
        <h2>Create the admin</h2>
        {#if failure}
          <Failure {failure} />
        {/if}
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
          autocomplete="new-password"
          required
          bind:value={password}
        />
        <label for="displayName">Display name</label>
        <input
          id="displayName"
          name="displayName"
          bind:value={displayName}
        />
        <button type="submit" disabled={busy}>Create admin</button>
      </form>
    {:else if step === 1}
      <form onsubmit={submitLibrary}>
        <h2>Add the first library</h2>
        {#if failure}
          <Failure {failure} />
        {/if}
        <label for="libraryName">Name</label>
        <input
          id="libraryName"
          name="libraryName"
          required
          bind:value={libraryName}
        />
        <label for="rootPath">Root path</label>
        <input
          id="rootPath"
          name="rootPath"
          required
          bind:value={rootPath}
        />
        <p class="muted">
          Enter an absolute path on the server, like /srv/movies.
        </p>
        <p class="muted">Medium: Movies</p>
        <button type="submit" disabled={busy}>Add library and scan</button>
      </form>
    {:else}
      <h2>Scan</h2>
      {#if failure}
        <Failure {failure} />
      {/if}
      {#if status}
        <dl class="counts">
          <div><dt>Queued</dt><dd>{status.counts.queued}</dd></div>
          <div><dt>Running</dt><dd>{status.counts.running}</dd></div>
          <div><dt>Completed</dt><dd>{status.counts.completed}</dd></div>
          <div><dt>Failed</dt><dd>{status.counts.failed}</dd></div>
        </dl>
        {#if scanFailed}
          <div class="failure" role="alert">
            <h3>The scan failed</h3>
            <p>{status?.latest?.error ?? "The scan job failed."}</p>
          </div>
          <button type="button" onclick={rescan} disabled={busy}>
            Scan again
          </button>
        {:else if scanDone}
          <p>The first scan is done.</p>
          <a class="open" href="/admin">Open the admin</a>
        {:else}
          <p class="muted">Scanning the library.</p>
        {/if}
      {:else}
        <p class="muted">Starting the scan.</p>
      {/if}
    {/if}
  </section>
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

.steps {
  display: flex;
  gap: 24px;
  margin: 0 0 24px;
  padding: 0;
  list-style: none;
}

.steps li {
  display: grid;
  gap: 2px;
  color: var(--muted);
}

.steps li[aria-current="step"] {
  color: var(--ink);
}

.steps .marker {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.panel {
  width: 100%;
  max-width: 360px;
  min-height: 320px;
}

.panel form {
  display: grid;
  gap: 8px;
}

.panel h2 {
  margin: 0 0 12px;
}

.panel .failure {
  margin-bottom: 12px;
}

.panel form button {
  margin-top: 8px;
}

.counts {
  display: flex;
  gap: 24px;
  margin: 0 0 16px;
}

.counts div {
  display: grid;
  gap: 2px;
}

.counts dt {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.counts dd {
  margin: 0;
  font-size: 20px;
}

.open {
  color: var(--signal);
}
</style>
