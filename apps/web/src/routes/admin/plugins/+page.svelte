<script lang="ts">
import { tick } from "svelte";
import { client } from "$lib/api.ts";
import ConfigForm from "$lib/components/ConfigForm.svelte";
import Failure from "$lib/components/Failure.svelte";
import FilesSwitch from "$lib/components/FilesSwitch.svelte";
import { readFailure } from "$lib/errors.ts";
import {
  describeCapabilities,
  type FilesOff,
  type InstalledPlugin,
} from "$lib/plugins.ts";
import { resource } from "$lib/resource.svelte.ts";

type FailureShape = ReturnType<typeof readFailure>;
type Preview = Awaited<ReturnType<typeof client.plugins.preview>>;

const plugins = resource(() => client.plugins.list());
const registries = resource(() => client.registries.list());
const denied = $derived(
  plugins.failure?.code === "FORBIDDEN" ||
    plugins.failure?.code === "UNAUTHORIZED",
);

let source = $state("");
let previewBusy = $state(false);
let previewFailure = $state<FailureShape | undefined>(undefined);
let preview = $state<Preview | undefined>(undefined);
let installBusy = $state(false);
let installFailure = $state<FailureShape | undefined>(undefined);
let installNotice = $state("");
let review = $state<HTMLElement | undefined>(undefined);

let toggleBusy = $state<Record<string, boolean>>({});
let toggleFailures = $state<Record<string, FailureShape>>({});

let registryUrl = $state("");
let registryBusy = $state(false);
let registryFailure = $state<FailureShape | undefined>(undefined);
let removeFailures = $state<Record<string, FailureShape>>({});

async function previewSource(event?: SubmitEvent) {
  event?.preventDefault();
  previewBusy = true;
  previewFailure = undefined;
  installFailure = undefined;
  installNotice = "";
  preview = undefined;
  try {
    preview = await client.plugins.preview({ source });
    await tick();
    review?.focus();
  } catch (error) {
    previewFailure = readFailure(error);
  } finally {
    previewBusy = false;
  }
}

async function previewEntry(entrySource: string) {
  source = entrySource;
  await previewSource();
}

async function install(previewed: Preview) {
  installBusy = true;
  installFailure = undefined;
  try {
    plugins.set(
      await client.plugins.install({
        source: previewed.source,
        integrity: previewed.integrity,
      }),
    );
    installNotice = `Installed ${previewed.name} ${previewed.version}.`;
    preview = undefined;
    source = "";
  } catch (error) {
    installFailure = readFailure(error);
  } finally {
    installBusy = false;
  }
}

async function setEnabled(plugin: InstalledPlugin, enabled: boolean) {
  toggleBusy[plugin.name] = true;
  delete toggleFailures[plugin.name];
  try {
    plugins.set(
      await client.plugins.setEnabled({ name: plugin.name, enabled }),
    );
  } catch (error) {
    toggleFailures[plugin.name] = readFailure(error);
  } finally {
    toggleBusy[plugin.name] = false;
  }
}

async function setFiles(off: FilesOff, name?: string) {
  plugins.set(await client.plugins.setFiles({ name, off }));
}

async function saveConfig(name: string, config: Record<string, unknown>) {
  plugins.set(await client.plugins.setConfig({ name, config }));
}

async function addRegistry(event: SubmitEvent) {
  event.preventDefault();
  registryBusy = true;
  registryFailure = undefined;
  const url = registryUrl;
  try {
    await client.registries.add({ url });
    if (registryUrl === url) registryUrl = "";
    await registries.reload();
  } catch (error) {
    registryFailure = readFailure(error);
  } finally {
    registryBusy = false;
  }
}

async function removeRegistry(url: string) {
  delete removeFailures[url];
  try {
    await client.registries.remove({ url });
    await registries.reload();
  } catch (error) {
    removeFailures[url] = readFailure(error);
  }
}

function stateOf(plugin: InstalledPlugin) {
  if (plugin.failure) return "Failed";
  return plugin.enabled ? "Enabled" : "Disabled";
}

function toggleLabel(plugin: InstalledPlugin) {
  if (plugin.enabled) return "Disable";
  return plugin.failure ? "Restart" : "Enable";
}

function failedAt(at: string) {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
</script>

<svelte:head>
  <title>Plugins · Pendia admin</title>
</svelte:head>

<h2>Plugins</h2>

{#if plugins.failure}
  <Failure failure={plugins.failure} />
  {#if !denied}
    <button
      type="button"
      onclick={() => plugins.reload()}
      disabled={plugins.loading}>Retry</button
    >
  {/if}
{:else if !plugins.data}
  <p class="muted">Loading.</p>
{:else}
  <section aria-labelledby="installed">
    <h3 id="installed">Installed</h3>
    <FilesSwitch
      id="files-all"
      label="File access for every plugin"
      off={plugins.data.filesOff}
      save={(off) => setFiles(off)}
    />
    {#each plugins.data.plugins as plugin (plugin.name)}
      <article class="plugin">
        <div class="head">
          <div class="title">
            <h4>{plugin.name} <span class="muted">{plugin.version}</span></h4>
            <p class="muted source">{plugin.source}</p>
          </div>
          <span class="state" data-state={stateOf(plugin)}
            >{stateOf(plugin)}</span
          >
          <button
            type="button"
            onclick={() => setEnabled(plugin, !plugin.enabled)}
            disabled={toggleBusy[plugin.name] === true}
            >{toggleLabel(plugin)}</button
          >
        </div>
        {#if Object.hasOwn(toggleFailures, plugin.name)}
          <Failure failure={toggleFailures[plugin.name]} />
        {/if}
        {#if plugin.failure}
          <p class="failed">
            Failed {failedAt(plugin.failure.at)}: {plugin.failure.message}
          </p>
        {/if}
        {#if plugin.capabilities.length > 0}
          <ul class="capabilities">
            {#each describeCapabilities(plugin.capabilities, plugin.network) as line (line)}
              <li>{line}</li>
            {/each}
          </ul>
        {/if}
        {#if plugin.capabilities.includes("files")}
          <FilesSwitch
            id={`files-${plugin.name}`}
            label="File access"
            off={plugin.filesOff}
            save={(off) => setFiles(off, plugin.name)}
          />
        {/if}
        {#if plugin.configFields.length > 0}
          <details>
            <summary>Settings</summary>
            <ConfigForm
              {plugin}
              save={(config) => saveConfig(plugin.name, config)}
            />
          </details>
        {/if}
      </article>
    {:else}
      <p class="muted">No plugins installed yet. Install one below.</p>
    {/each}
  </section>

  <section aria-labelledby="install">
    <h3 id="install">Install a plugin</h3>
    <form onsubmit={previewSource} class="stack">
      {#if previewFailure}
        <Failure failure={previewFailure} />
      {/if}
      <label for="source">Source</label>
      <input
        id="source"
        name="source"
        required
        autocomplete="off"
        spellcheck="false"
        bind:value={source}
      />
      <p class="muted">An absolute folder path, a tarball URL or an npm package name.</p>
      <button type="submit" disabled={previewBusy}>Preview</button>
    </form>
    {#if installNotice}
      <p aria-live="polite">{installNotice}</p>
    {/if}
    {#if preview}
      <div class="review" tabindex="-1" bind:this={review}>
        <h4>{preview.name} <span class="muted">{preview.version}</span></h4>
        {#if preview.installedVersion}
          <p>Replaces version {preview.installedVersion}.</p>
        {/if}
        {#if preview.capabilities.length > 0}
          <p>It asks to:</p>
          <ul class="capabilities">
            {#each describeCapabilities(preview.capabilities, preview.network) as line (line)}
              <li>{line}</li>
            {/each}
          </ul>
        {:else}
          <p>It asks for no capabilities.</p>
        {/if}
        {#if preview.capabilities.includes("files")}
          <div class="warning" role="note">
            <strong>This plugin can change your media collection.</strong>
            It can read, write and delete files in your libraries. You can switch
            its file access off at any time.
          </div>
        {/if}
        {#if installFailure}
          <Failure failure={installFailure} />
        {/if}
        <div class="row">
          <button
            type="button"
            onclick={() => preview && install(preview)}
            disabled={installBusy}>Install {preview.name}</button
          >
          <button type="button" onclick={() => (preview = undefined)}
            >Cancel</button
          >
        </div>
      </div>
    {/if}
  </section>

  <section aria-labelledby="registries">
    <h3 id="registries">Registries</h3>
    {#if registries.failure}
      <Failure failure={registries.failure} />
    {:else if !registries.data}
      <p class="muted">Loading.</p>
    {:else}
      {#each registries.data as registry (registry.url)}
        <div class="registry">
          <div class="head">
            <p class="url">{registry.url}</p>
            <button type="button" onclick={() => removeRegistry(registry.url)}
              >Remove</button
            >
          </div>
          {#if Object.hasOwn(removeFailures, registry.url)}
            <Failure failure={removeFailures[registry.url]} />
          {/if}
          {#if registry.error}
            <p class="muted">{registry.error}</p>
          {:else if registry.entries.length === 0}
            <p class="muted">This registry lists no plugins.</p>
          {:else}
            <ul class="entries">
              {#each registry.entries as entry (entry.name)}
                {@const latest = entry.versions[0]}
                <li>
                  <div>
                    <span class="name">{entry.name}</span>
                    {#if entry.description}
                      <span class="muted">{entry.description}</span>
                    {/if}
                  </div>
                  {#if latest}
                    <button
                      type="button"
                      onclick={() => previewEntry(latest.source)}
                      disabled={previewBusy}>Preview {latest.version}</button
                    >
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {:else}
        <p class="muted">No registries. Add one to browse its plugins.</p>
      {/each}
    {/if}
    <form onsubmit={addRegistry} class="stack">
      {#if registryFailure}
        <Failure failure={registryFailure} />
      {/if}
      <label for="registryUrl">Registry URL</label>
      <input
        id="registryUrl"
        name="url"
        type="url"
        required
        bind:value={registryUrl}
      />
      <button type="submit" disabled={registryBusy}>Add registry</button>
    </form>
  </section>
{/if}

<style>
section {
  max-width: 760px;
  margin-bottom: 40px;
}

h4 {
  margin: 0;
  font-size: 16px;
  overflow-wrap: anywhere;
}

.plugin,
.registry {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding: 16px 0 0;
  border-top: 1px solid var(--line);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}

.title {
  flex: 1;
  min-width: 0;
}

.title p,
.url {
  margin: 0;
  overflow-wrap: anywhere;
}

.state {
  color: var(--muted);
}

.state[data-state="Failed"],
.failed {
  color: var(--danger);
}

.failed {
  margin: 0;
}

.capabilities {
  margin: 0;
  padding-left: 20px;
}

.stack {
  display: grid;
  max-width: 420px;
  gap: 8px;
  margin-top: 16px;
}

.stack p {
  margin: 0;
}

.review {
  display: grid;
  gap: 12px;
  max-width: 560px;
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.review p {
  margin: 0;
}

.warning {
  padding: 12px 16px;
  border: 1px solid var(--danger);
  border-radius: 8px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.entries {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.entries li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}

.entries .name {
  margin-right: 8px;
  font-weight: 600;
}

summary {
  cursor: pointer;
}

details[open] summary {
  margin-bottom: 12px;
}

section :global(.failure) {
  margin: 4px 0;
}
</style>
