<script lang="ts">
import { onDestroy } from "svelte";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FolderFields from "$lib/components/admin/FolderFields.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ScanState from "$lib/components/admin/ScanState.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import { queuesScan, type RootDraft, refusedRoot } from "$lib/roots.ts";
import { type ScanStatus, waitForScan } from "$lib/scan.ts";
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

let nameBusy = $state(false);
let nameFailure = $state<FailureShape | undefined>(undefined);

async function saveName(event: SubmitEvent) {
  event.preventDefault();
  if (!library.data) return;
  nameBusy = true;
  nameFailure = undefined;
  try {
    const answer = await client.libraries.update({ id, name });
    library.set(answer);
    name = answer.name;
    toast.success("Name saved");
  } catch (error) {
    nameFailure = readFailure(error);
  } finally {
    nameBusy = false;
  }
}

let refusal = $state<{ index: number; message: string } | undefined>(undefined);
let folderFailure = $state<FailureShape | undefined>(undefined);

/** Saves one folder change at once; throws so the folder browser stays open on failure. */
async function sendRoots(sent: RootDraft[]) {
  const saved = library.data?.roots;
  if (!saved) return;
  try {
    const answer = await client.libraries.update({ id, roots: sent });
    refusal = undefined;
    folderFailure = undefined;
    library.set(answer);
    return { answer, queued: queuesScan(saved, sent) };
  } catch (error) {
    const refused = refusedRoot(error);
    if (refused !== undefined && refused.index < sent.length) refusal = refused;
    throw error;
  }
}

async function addFolder(path: string) {
  const roots = library.data?.roots;
  if (!roots) return;
  const sent = [...roots, { path }];
  const result = await sendRoots(sent);
  if (!result) return;
  toast.success(
    result.queued
      ? `Folder added. Scanning ${result.answer.name}.`
      : "Folder added.",
  );
}

async function repointFolder(index: number, path: string) {
  const roots = library.data?.roots;
  if (!roots) return;
  const sent = roots.map((root, at) =>
    at === index ? { ...root, path } : { id: root.id, path: root.path },
  );
  const result = await sendRoots(sent);
  if (!result) return;
  toast.success(
    result.queued
      ? `Folder changed. Scanning ${result.answer.name}.`
      : "Folder changed.",
  );
}

async function removeFolder(index: number) {
  const roots = library.data?.roots;
  if (!roots) return;
  try {
    const result = await sendRoots(roots.filter((_, at) => at !== index));
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
    deleteFailure = readFailure(error);
    throw error;
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
      refusal={refusal ?? undefined}
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
          <ScanState {status} withTime />
        </FormRow>
      {/if}
      {#snippet actions()}
        <Button variant="secondary" onclick={scanNow} disabled={scanBusy}
          >{scanRun === undefined ? "Scan now" : "Check again"}</Button
        >
      {/snippet}
    </FormGroup>

    <PolicyEditor {id} />

    <FormGroup failure={deleteFailure ?? undefined}>
      <div class="flex min-h-12 items-center px-4 py-2.5">
        <Button variant="destructive" onclick={() => (deleteOpen = true)}
          >Delete library</Button
        >
      </div>
    </FormGroup>
  {/if}

  <ConfirmDialog
    bind:open={deleteOpen}
    title="Delete {library.data?.name}?"
    description="Its Items and watch history leave Pendia. The files stay on disk."
    action="Delete library"
    onconfirm={deleteLibrary}
  />
</AdminPage>
