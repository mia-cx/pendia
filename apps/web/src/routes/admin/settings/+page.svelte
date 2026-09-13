<script lang="ts">
import { client } from "$lib/api.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";

const settings = resource(() => client.settings.get());

type FailureShape = ReturnType<typeof readFailure>;

let proxyInput = $state<string | null>(null);
let proxyBusy = $state(false);
let proxyFailure = $state<FailureShape | undefined>(undefined);

let artChecked = $state<boolean | null>(null);
let artBusy = $state(false);
let artFailure = $state<FailureShape | undefined>(undefined);

let keyName = $state("");
let keyValue = $state("");
let keyBusy = $state(false);
let keyFailure = $state<FailureShape | undefined>(undefined);

let removeBusy = $state<Record<string, boolean>>({});
let removeFailures = $state<Record<string, FailureShape>>({});

const proxyValue = $derived(
  proxyInput ?? (settings.data?.trustedProxyAddresses ?? []).join("\n"),
);

let pending: Promise<unknown> = Promise.resolve();

function serial<T>(run: () => Promise<T>) {
  const next = pending.then(run, run);
  pending = next.catch(() => {});
  return next;
}

async function saveProxies(event: SubmitEvent) {
  event.preventDefault();
  proxyBusy = true;
  proxyFailure = undefined;
  try {
    const lines = proxyValue
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    settings.set(
      await serial(() =>
        client.settings.update({ trustedProxyAddresses: lines }),
      ),
    );
    proxyInput = null;
  } catch (error) {
    proxyFailure = readFailure(error);
  } finally {
    proxyBusy = false;
  }
}

async function saveArtwork(checked: boolean) {
  artBusy = true;
  artFailure = undefined;
  try {
    settings.set(
      await serial(() =>
        client.settings.update({ artworkRequiresAuth: checked }),
      ),
    );
    artChecked = null;
  } catch (error) {
    artChecked = null;
    artFailure = readFailure(error);
  } finally {
    artBusy = false;
  }
}

async function addKey(event: SubmitEvent) {
  event.preventDefault();
  keyBusy = true;
  keyFailure = undefined;
  const name = keyName.trim();
  const value = keyValue;
  try {
    settings.set(
      await serial(() => client.settings.setProviderKey({ name, value })),
    );
    keyName = "";
    keyValue = "";
  } catch (error) {
    keyFailure = readFailure(error);
  } finally {
    keyBusy = false;
  }
}

async function removeKey(name: string) {
  removeBusy[name] = true;
  delete removeFailures[name];
  try {
    settings.set(
      await serial(() => client.settings.deleteProviderKey({ name })),
    );
  } catch (error) {
    removeFailures[name] = readFailure(error);
  } finally {
    removeBusy[name] = false;
  }
}
</script>

<svelte:head>
  <title>Settings · Pendia admin</title>
</svelte:head>

<h2>Settings</h2>

{#if settings.failure}
  <Failure failure={settings.failure} />
{:else if !settings.data}
  <p class="muted">Loading.</p>
{:else}
  <section>
    <h3>Trusted proxies</h3>
    <p class="muted">
      Trust is by exact IP address, not CIDR or hostname. No proxy is trusted
      by default.
    </p>
    <form onsubmit={saveProxies} class="stack">
      {#if proxyFailure}
        <Failure failure={proxyFailure} />
      {/if}
      <label for="proxyList">One address per line</label>
      <textarea
        id="proxyList"
        name="proxies"
        rows="4"
        value={proxyValue}
        oninput={(event) => (proxyInput = event.currentTarget.value)}
      ></textarea>
      <button type="submit" disabled={proxyBusy}>Save</button>
    </form>
  </section>

  <section>
    <h3>Artwork auth</h3>
    <p class="muted">
      Artwork routes accept anonymous requests by default, and nothing enforces
      this toggle yet because no artwork route exists in this build.
    </p>
    <div class="check">
      <input
        id="artworkAuth"
        type="checkbox"
        checked={artChecked ?? settings.data.artworkRequiresAuth}
        onchange={(event) => {
          artChecked = event.currentTarget.checked;
          void saveArtwork(artChecked);
        }}
        disabled={artBusy}
      />
      <label for="artworkAuth">Require auth for artwork</label>
    </div>
    {#if artFailure}
      <Failure failure={artFailure} />
    {/if}
  </section>

  <section>
    <h3>Provider keys</h3>
    <p class="muted">
      A key value is write-only and never read back, so the table lists names
      only.
    </p>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each settings.data.providerKeys as name (name)}
          <tr>
            <td class="name">{name}</td>
            <td class="actions">
              <button
                type="button"
                onclick={() => removeKey(name)}
                disabled={removeBusy[name] === true}>Remove</button
              >
              {#if removeFailures[name]}
                <Failure failure={removeFailures[name]} />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if settings.data.providerKeys.length === 0}
      <p class="muted">No provider keys set.</p>
    {/if}
    <form onsubmit={addKey} class="stack keys">
      {#if keyFailure}
        <Failure failure={keyFailure} />
      {/if}
      <label for="keyName">Name</label>
      <input id="keyName" name="name" required bind:value={keyName} />
      <label for="keyValue">Value</label>
      <input
        id="keyValue"
        name="value"
        type="password"
        autocomplete="off"
        required
        bind:value={keyValue}
      />
      <button type="submit" disabled={keyBusy}>Set key</button>
    </form>
  </section>

  <section>
    <h3>OIDC</h3>
    <p>{settings.data.oidcConfigured ? "Configured" : "Not configured"}</p>
    <p class="muted">
      OIDC is configured in the database in this slice; see
      apps/server/README.md.
    </p>
  </section>
{/if}

<style>
section {
  max-width: 720px;
  margin-bottom: 32px;
}

.stack {
  display: grid;
  max-width: 360px;
  gap: 8px;
  align-content: start;
}

.keys {
  margin-top: 16px;
}

table {
  table-layout: fixed;
  max-width: 480px;
}

td {
  height: 48px;
  vertical-align: middle;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  white-space: nowrap;
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

section :global(.failure) {
  margin: 8px 0;
}
</style>
