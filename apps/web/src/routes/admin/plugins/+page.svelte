<script lang="ts">
import FolderPenIcon from "@lucide/svelte/icons/folder-pen";
import PlusIcon from "@lucide/svelte/icons/plus";
import PuzzleIcon from "@lucide/svelte/icons/puzzle";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import CapabilityList from "$lib/components/admin/CapabilityList.svelte";
import EmptyState from "$lib/components/admin/EmptyState.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import PluginCard from "$lib/components/admin/PluginCard.svelte";
import ConfigForm from "$lib/components/ConfigForm.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import Failure from "$lib/components/Failure.svelte";
import FilesSwitch from "$lib/components/FilesSwitch.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Dialog from "$lib/components/ui/dialog/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import { readFailure } from "$lib/errors.ts";
import {
  entryAction,
  type FilesOff,
  type InstalledPlugin,
  pluginOrigin,
  type RegistryEntry,
  registryLabel,
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
let addOpen = $state(false);
let previewBusy = $state(false);
let previewFailure = $state<FailureShape | undefined>(undefined);
let preview = $state<Preview | undefined>(undefined);
let installBusy = $state(false);
let installFailure = $state<FailureShape | undefined>(undefined);
let previewTitle = $state<HTMLElement | null>(null);

let configuring = $state<string | undefined>(undefined);
const configuringPlugin = $derived(
  plugins.data?.plugins.find((plugin) => plugin.name === configuring),
);

let cardBusy = $state<Record<string, boolean>>({});
let cardFailures = $state<Record<string, FailureShape>>({});
let entryPreviewBusy = $state<string | undefined>(undefined);
let entryPreviewFailure = $state<FailureShape | undefined>(undefined);

let filesAllFailure = $state<FailureShape | undefined>(undefined);
let filesPluginFailures = $state<Record<string, FailureShape>>({});

const severalRegistries = $derived((registries.data?.length ?? 0) > 1);

let registryUrl = $state("");
let registryBusy = $state(false);
let registryFailure = $state<FailureShape | undefined>(undefined);
let registryRemoveFailure = $state<FailureShape | undefined>(undefined);

function openAdd() {
  source = "";
  preview = undefined;
  previewFailure = undefined;
  installFailure = undefined;
  addOpen = true;
}

async function previewSource(event?: SubmitEvent) {
  event?.preventDefault();
  previewBusy = true;
  previewFailure = undefined;
  installFailure = undefined;
  preview = undefined;
  try {
    preview = await client.plugins.preview({ source });
    await tick();
    previewTitle?.focus();
  } catch (error) {
    previewFailure = readFailure(error);
  } finally {
    previewBusy = false;
  }
}

async function previewEntry(entry: RegistryEntry) {
  const latest = entry.versions[0];
  if (latest === undefined) return;
  entryPreviewBusy = entry.name;
  entryPreviewFailure = undefined;
  try {
    source = latest.source;
    preview = await client.plugins.preview({ source: latest.source });
    previewFailure = undefined;
    installFailure = undefined;
    addOpen = true;
    await tick();
    previewTitle?.focus();
  } catch (error) {
    entryPreviewFailure = readFailure(error);
  } finally {
    entryPreviewBusy = undefined;
  }
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
    toast.success(`Installed ${previewed.name} ${previewed.version}`);
    addOpen = false;
  } catch (error) {
    installFailure = readFailure(error);
  } finally {
    installBusy = false;
  }
}

async function setEnabled(plugin: InstalledPlugin, enabled: boolean) {
  cardBusy[plugin.name] = true;
  delete cardFailures[plugin.name];
  try {
    plugins.set(
      await client.plugins.setEnabled({ name: plugin.name, enabled }),
    );
  } catch (error) {
    cardFailures[plugin.name] = readFailure(error);
  } finally {
    cardBusy[plugin.name] = false;
  }
}

async function remove(plugin: InstalledPlugin) {
  try {
    plugins.set(await client.plugins.remove({ name: plugin.name }));
    toast.success(`Removed ${plugin.name}`);
  } catch (error) {
    cardFailures[plugin.name] = readFailure(error);
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
    toast.success(`Added ${registryLabel(url)}`);
  } catch (error) {
    registryFailure = readFailure(error);
  } finally {
    registryBusy = false;
  }
}

async function removeRegistry(url: string) {
  registryRemoveFailure = undefined;
  try {
    await client.registries.remove({ url });
    await registries.reload();
    toast.success(`Removed ${registryLabel(url)}`);
  } catch (error) {
    registryRemoveFailure = readFailure(error);
  }
}

function registryRemoveDescription(count: number) {
  if (count === 0) return "Plugins you installed from it stay installed.";
  if (count === 1)
    return "Its one plugin leaves Available. Plugins you installed from it stay installed.";
  return `Its ${count} plugins leave Available. Plugins you installed from it stay installed.`;
}
</script>

<AdminPage title="Plugins">
  {#snippet actions()}
    <Button onclick={openAdd}><PlusIcon />Add plugin</Button>
  {/snippet}

  {#if plugins.failure}
    <Failure failure={plugins.failure} />
    {#if !denied}
      <div>
        <Button
          variant="secondary"
          onclick={() => plugins.reload()}
          disabled={plugins.loading}>Try again</Button
        >
      </div>
    {/if}
  {:else}
    <FormGroup
      title="Installed"
      bare={plugins.data === undefined || plugins.data.plugins.length > 0}
    >
      {#if !plugins.data}
        <ul class="grid gap-3 @xl:grid-cols-2">
          {#each { length: 2 } as _, i (i)}
            <li>
              <div
                class="flex h-full flex-col rounded-lg bg-elevated p-4 contrast-more:ring-1 contrast-more:ring-separator"
              >
                <div class="flex items-start gap-3">
                  <Skeleton class="size-10 shrink-0 rounded-md" />
                  <div class="min-w-0 flex-1">
                    <Skeleton class="h-4 w-3/5" />
                    <Skeleton class="mt-1.5 h-3 w-2/5" />
                  </div>
                  <Skeleton class="h-6.5 w-11 rounded-full" />
                </div>
                <div class="mt-3 flex items-center gap-2">
                  <Skeleton class="size-2 rounded-full" />
                  <Skeleton class="h-3 w-10" />
                </div>
                <div class="mt-auto flex gap-2 pt-4">
                  <Skeleton class="h-8 w-24 rounded-md" />
                  <Skeleton class="h-8 w-20 rounded-md" />
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {:else if plugins.data.plugins.length === 0}
        <EmptyState icon={PuzzleIcon} title="No plugins">
          <Button variant="secondary" onclick={openAdd}>Add plugin</Button>
        </EmptyState>
      {:else}
        <ul class="grid gap-3 @xl:grid-cols-2">
          {#each plugins.data.plugins as plugin (plugin.name)}
            <PluginCard
              {plugin}
              origin={pluginOrigin(plugin.source, registries.data ?? [])}
              busy={cardBusy[plugin.name] === true}
              failure={cardFailures[plugin.name]}
              ontoggle={(enabled) => void setEnabled(plugin, enabled)}
              onconfigure={() => (configuring = plugin.name)}
              onremove={() => remove(plugin)}
            />
          {/each}
        </ul>
      {/if}
    </FormGroup>

    {#if plugins.data}
      <FormGroup title="File access" failure={filesAllFailure}>
        <FormRow label="All plugins" for="files-all" inline>
          <FilesSwitch
            id="files-all"
            off={plugins.data.filesOff}
            save={(off) => setFiles(off)}
            onfailure={(failure) => (filesAllFailure = failure)}
          />
        </FormRow>
      </FormGroup>
    {/if}

    <FormGroup
      title="Available"
      loading={registries.data === undefined && !registries.failure ? 2 : undefined}
      failure={entryPreviewFailure}
    >
      {#each registries.data ?? [] as registry (registry.url)}
        {#each registry.entries as entry (entry.name)}
          {@const action = entryAction(entry, plugins.data?.plugins ?? [])}
          <ListRow
            title={entry.name}
            caption={[
              entry.description,
              severalRegistries ? registryLabel(registry.url) : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined}
          >
            {#snippet leading()}
              <span
                class="flex size-7 items-center justify-center rounded-sm bg-fill-strong text-label"
              >
                <PuzzleIcon class="size-4" aria-hidden="true" />
              </span>
            {/snippet}
            {#if action === "installed"}
              <span class="text-footnote text-label-secondary">Installed</span>
            {:else}
              <Button
                size="sm"
                variant="secondary"
                aria-label="{action === 'update' ? 'Update' : 'Install'} {entry.name}"
                disabled={entryPreviewBusy !== undefined}
                onclick={() => void previewEntry(entry)}
                >{action === "update" ? "Update" : "Install"}</Button
              >
            {/if}
          </ListRow>
        {/each}
      {/each}
      {#if registries.data && registries.data.every((registry) => registry.entries.length === 0)}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >{registries.data.length === 0
              ? "Add a registry to browse its plugins."
              : "Your registries list no plugins."}</span
          >
        </div>
      {/if}
    </FormGroup>

    <FormGroup
      title="Registries"
      onsubmit={addRegistry}
      failure={registryFailure ?? registryRemoveFailure}
      description="A registry is a list of plugins you can install."
      loading={registries.data === undefined && !registries.failure ? 1 : undefined}
    >
      {#each registries.data ?? [] as registry (registry.url)}
        {@const label = registryLabel(registry.url)}
        <ListRow
          title={label}
          caption={registry.error ?? registry.url}
          tone={registry.error !== null ? "destructive" : "secondary"}
        >
          <ConfirmDialog
            title="Remove {label}?"
            description={registryRemoveDescription(registry.entries.length)}
            action="Remove registry"
            onconfirm={() => removeRegistry(registry.url)}
          >
            {#snippet trigger(props)}
              <Button
                {...props}
                variant="ghost"
                size="sm"
                class="text-destructive"
                aria-label="Remove {label}">Remove</Button
              >
            {/snippet}
          </ConfirmDialog>
        </ListRow>
      {:else}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary">No registries</span
          >
        </div>
      {/each}
      <FormRow label="Add a registry" for="registryUrl">
        <Input
          id="registryUrl"
          name="url"
          type="url"
          required
          placeholder="https://"
          bind:value={registryUrl}
        />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={registryBusy}>Add</Button>
      {/snippet}
    </FormGroup>
  {/if}
</AdminPage>

<Dialog.Root
  open={configuring !== undefined && configuringPlugin !== undefined}
  onOpenChange={(open) => {
    if (!open) configuring = undefined;
  }}
>
  <Dialog.Content
    class="max-h-[calc(100svh-2rem)] max-w-lg overflow-y-auto"
  >
    {#if configuringPlugin}
      {@const plugin = configuringPlugin}
      <Dialog.Header>
        <Dialog.Title class="pe-8 break-words">{plugin.name}</Dialog.Title>
        <Dialog.Description>
          Version {plugin.version} from {pluginOrigin(
            plugin.source,
            registries.data ?? [],
          )}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-6">
        <section>
          <h3 class="mb-2 px-1 text-headline">What it can do</h3>
          <CapabilityList
            capabilities={plugin.capabilities}
            network={plugin.network}
          />
        </section>
        {#if plugin.capabilities.includes("files")}
          <FormGroup
            title="File access"
            failure={filesPluginFailures[plugin.name]}
          >
            <FormRow label="This plugin" for="files-{plugin.name}" inline>
              <FilesSwitch
                id="files-{plugin.name}"
                off={plugin.filesOff}
                save={(off) => setFiles(off, plugin.name)}
                onfailure={(failure) => {
                  if (failure === undefined)
                    delete filesPluginFailures[plugin.name];
                  else filesPluginFailures[plugin.name] = failure;
                }}
              />
            </FormRow>
          </FormGroup>
        {/if}
        {#if plugin.configFields.length > 0}
          {#key plugin.name}
            <ConfigForm
              {plugin}
              save={(config) => saveConfig(plugin.name, config)}
            />
          {/key}
        {/if}
      </div>
      <Dialog.Footer>
        <Button onclick={() => (configuring = undefined)}>Done</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  bind:open={addOpen}
  onOpenChangeComplete={(open) => {
    if (!open) {
      preview = undefined;
      previewFailure = undefined;
      installFailure = undefined;
    }
  }}
>
  <Dialog.Content
    class="max-h-[calc(100svh-2rem)] max-w-lg overflow-y-auto"
  >
    {#if preview}
      {@const name = preview.name}
      <Dialog.Header>
        <Dialog.Title
          tabindex={-1}
          bind:ref={previewTitle}
          class="pe-8 break-words focus-visible:outline-none">{name}</Dialog.Title
        >
        <Dialog.Description>
          {#if preview.installedVersion === preview.version}
            Version {preview.version}, already installed
          {:else if preview.installedVersion}
            Version {preview.version}, replacing {preview.installedVersion}
          {:else}
            Version {preview.version}
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      <div
        class="flex flex-col gap-6 animate-in fade-in-0 duration-(--duration-fast)"
      >
        <section>
          <h3 class="mb-2 px-1 text-headline">What it can do</h3>
          <CapabilityList
            capabilities={preview.capabilities}
            network={preview.network}
          />
        </section>
        {#if preview.capabilities.includes("files")}
          <div
            role="note"
            class="flex gap-3 rounded-lg bg-destructive/8 px-4 py-3"
          >
            <FolderPenIcon class="mt-0.5 size-5 shrink-0 text-destructive" />
            <div>
              <h4 class="text-headline">It can change your media collection</h4>
              <p class="mt-0.5 text-subheadline text-label-secondary">
                You can turn its file access off at any time.
              </p>
            </div>
          </div>
        {/if}
        {#if installFailure}
          <Failure failure={installFailure} />
        {/if}
      </div>
      <Dialog.Footer>
        <Button variant="secondary" onclick={() => (addOpen = false)}
          >Cancel</Button
        >
        <Button onclick={() => preview && install(preview)} disabled={installBusy}
          >{preview.installedVersion === null
            ? "Install"
            : preview.installedVersion === preview.version
              ? "Reinstall"
              : "Update"}</Button
        >
      </Dialog.Footer>
    {:else}
      <Dialog.Header>
        <Dialog.Title class="pe-8 break-words">Add a plugin</Dialog.Title>
      </Dialog.Header>
      <div class="animate-in fade-in-0 duration-(--duration-fast)">
        <form onsubmit={previewSource} class="flex flex-col gap-4">
          <div
            class="rounded-lg bg-elevated contrast-more:ring-1 contrast-more:ring-separator"
          >
            <FormRow
              label="Source"
              for="source"
              hint="An npm package, a tarball URL or a folder on the server."
            >
              <Input
                id="source"
                name="source"
                required
                autocomplete="off"
                spellcheck="false"
                bind:value={source}
              />
            </FormRow>
          </div>
          {#if previewFailure}
            <Failure failure={previewFailure} />
          {/if}
          <Dialog.Footer>
            <Button variant="secondary" onclick={() => (addOpen = false)}
              >Cancel</Button
            >
            <Button type="submit" disabled={previewBusy}>Preview</Button>
          </Dialog.Footer>
        </form>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
