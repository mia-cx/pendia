<script lang="ts">
import { onDestroy } from "svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FolderFields from "$lib/components/admin/FolderFields.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ScanFailures from "$lib/components/admin/ScanFailures.svelte";
import ScanState from "$lib/components/admin/ScanState.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import Failure from "$lib/components/Failure.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import { queuesScan, type RootDraft } from "$lib/roots.ts";
import { type ScanStatus, waitForScan } from "$lib/scan.ts";
import { serialQueue } from "$lib/serial.ts";
import PolicyEditor from "./PolicyEditor.svelte";

// The route keys this component on the id, so it never outlives its library.
const { id }: { id: string } = $props();

const library = resource(() => client.libraries.get({ id }));
type LibraryData = NonNullable<typeof library.data>;
type FailureShape = ReturnType<typeof readFailure>;

const mediumNames: Record<LibraryData["medium"], string> = {
  movies: "Movies",
  shows: "Shows",
};

let loaded = false;
let name = $state("");
$effect(() => {
  if (!loaded && library.data) {
    loaded = true;
    name = library.data.name;
  }
});

// Library writes run through one queue so a slow rename can't overwrite newer roots.
const writeQueue = serialQueue();

let nameBusy = $state(false);
let nameFailure = $state<FailureShape | undefined>(undefined);

async function saveName(event: SubmitEvent) {
  event.preventDefault();
  if (!library.data) return;
  nameBusy = true;
  nameFailure = undefined;
  try {
    const answer = await writeQueue(async () => {
      const saved = await client.libraries.update({ id, name });
      library.set(saved);
      return saved;
    });
    name = answer.name;
    toast.success("Name saved");
  } catch (error) {
    nameFailure = readFailure(error);
  } finally {
    nameBusy = false;
  }
}

let folderFailure = $state<FailureShape | undefined>(undefined);

/**
 * Queues one folder change; the root list is built inside the job from the
 * roots current when it runs, so an earlier write can't clobber a later one.
 * Throws so the folder browser stays open on failure.
 */
async function sendRoots(plan: (roots: LibraryData["roots"]) => RootDraft[]) {
  return writeQueue(async () => {
    const saved = library.data?.roots;
    if (!saved) return;
    const sent = plan(saved);
    const answer = await client.libraries.update({ id, roots: sent });
    folderFailure = undefined;
    library.set(answer);
    return { answer, queued: queuesScan(saved, sent) };
  });
}

async function addFolder(path: string) {
  const result = await sendRoots((roots) => [...roots, { path }]);
  if (!result) return;
  toast.success(
    result.queued
      ? `Folder added. Scanning ${result.answer.name}.`
      : "Folder added",
  );
}

/** The index from click time, resolved to a root id the job can still find. */
function rootIdAt(index: number) {
  return library.data?.roots[index]?.id;
}

async function repointFolder(index: number, path: string) {
  const rootId = rootIdAt(index);
  if (rootId === undefined) return;
  const result = await sendRoots((roots) => {
    const at = roots.findIndex((root) => root.id === rootId);
    if (at === -1) throw new Error("That folder is no longer in this library.");
    return roots.map((root, i) =>
      i === at ? { ...root, path } : { id: root.id, path: root.path },
    );
  });
  if (!result) return;
  toast.success(
    result.queued
      ? `Folder changed. Scanning ${result.answer.name}.`
      : "Folder changed",
  );
}

async function removeFolder(index: number) {
  const rootId = rootIdAt(index);
  if (rootId === undefined) return;
  try {
    const result = await sendRoots((roots) => {
      const at = roots.findIndex((root) => root.id === rootId);
      if (at === -1)
        throw new Error("That folder is no longer in this library.");
      return roots.filter((_, i) => i !== at);
    });
    if (result) toast.success("Folder removed");
  } catch (error) {
    folderFailure = readFailure(error);
  }
}

let status = $state<ScanStatus | null | undefined>(undefined);
let scanBusy = $state(false);
let scanRun = $state<string | undefined>(undefined);
let scanFailure = $state<FailureShape | undefined>(undefined);

const controller = new AbortController();
onDestroy(() => controller.abort());

$effect(() => {
  if (library.data && status === undefined) void loadStatus();
});

async function loadStatus() {
  try {
    status = await client.libraries.scanStatus({ id });
  } catch {
    status = null;
  }
}

/** Starts a scan and follows it, or follows the run already in flight. */
async function scanNow() {
  scanBusy = true;
  scanFailure = undefined;
  try {
    const jobId = scanRun ?? (await client.libraries.scan({ id })).jobId;
    scanRun = jobId;
    const settled = await waitForScan(client, id, {
      signal: controller.signal,
      runId: jobId,
      onStatus: (reading) => (status = reading),
    });
    status = settled;
    scanRun = undefined;
  } catch (error) {
    if (!controller.signal.aborted) scanFailure = readFailure(error);
  } finally {
    scanBusy = false;
  }
}

let deleteOpen = $state(false);
let deleteFailure = $state<FailureShape | undefined>(undefined);

async function deleteLibrary() {
  const current = library.data;
  if (!current) return;
  try {
    await client.libraries.delete({ id });
    toast.success(`${current.name} deleted`);
    await goto("/admin/libraries");
  } catch (error) {
    // ConfirmDialog has no error state; let it close and show the failure instead.
    deleteFailure = readFailure(error);
  }
}
</script>

<AdminPage
  title={library.data?.name ?? "Library"}
  parent={{ href: "/admin/libraries", label: "Libraries" }}
>
  <FormGroup
    onsubmit={saveName}
    loading={library.data === undefined && !library.failure ? 2 : undefined}
    failure={library.failure ?? nameFailure}
  >
    {#if library.data}
      <FormRow label="Name" for="libraryName">
        <Input id="libraryName" name="name" required bind:value={name} />
      </FormRow>
      <FormRow label="Medium" inline>
        <span class="text-subheadline text-label-secondary"
          >{mediumNames[library.data.medium]}</span
        >
      </FormRow>
    {/if}
    {#snippet actions()}
      {#if library.failure}
        <Button
          variant="secondary"
          onclick={() => library.reload()}
          disabled={library.loading}>Try again</Button
        >
      {:else if library.data}
        <Button
          type="submit"
          disabled={nameBusy || name === library.data.name}>Save</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  {#if library.data}
    <FolderFields
      rows={library.data.roots}
      medium={library.data.medium}
      onadd={addFolder}
      onrepoint={repointFolder}
      onremove={removeFolder}
      failure={folderFailure ?? undefined}
    />

    <FormGroup
      title="Scan"
      loading={status === undefined ? 1 : undefined}
      failure={scanFailure ?? undefined}
    >
      {#if status !== undefined}
        <FormRow label="Status" inline>
          <ScanState {status} withTime class="items-end @lg:items-start" />
        </FormRow>
        {#if status && status.failures.total > 0}
          <ScanFailures
            failures={status.failures}
            withRoot={library.data.roots.length > 1}
          />
        {/if}
      {/if}
      {#snippet actions()}
        <Button variant="secondary" onclick={scanNow} disabled={scanBusy}
          >{scanRun === undefined ? "Scan now" : "Check again"}</Button
        >
      {/snippet}
    </FormGroup>

    <PolicyEditor {id} />

    <div class="flex flex-col items-start gap-2">
      <Button variant="destructive" onclick={() => (deleteOpen = true)}
        >Delete library</Button
      >
      {#if deleteFailure}
        <Failure inline failure={deleteFailure} />
      {/if}
    </div>
  {/if}

  <ConfirmDialog
    bind:open={deleteOpen}
    title="Delete {library.data?.name}?"
    description="Its Items and watch history leave Thalia. The files stay on disk."
    action="Delete library"
    onconfirm={deleteLibrary}
  />
</AdminPage>
