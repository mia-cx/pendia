<script lang="ts">
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FolderFields from "$lib/components/admin/FolderFields.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { readFailure } from "$lib/errors.ts";
import { type RootDraft, refusedRoot } from "$lib/roots.ts";

type Medium = "movies" | "shows";
const mediumNames: Record<Medium, string> = {
  movies: "Movies",
  shows: "Shows",
};

let name = $state("");
let medium = $state<Medium>("movies");
let rows = $state<RootDraft[]>([]);
let busy = $state(false);
let refusal = $state<{ index: number; message: string } | undefined>(undefined);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

async function addFolder(path: string) {
  rows = [...rows, { path }];
  refusal = undefined;
}

async function repointFolder(index: number, path: string) {
  rows = rows.map((row, at) => (at === index ? { ...row, path } : row));
  refusal = undefined;
}

async function removeFolder(index: number) {
  rows = rows.filter((_, at) => at !== index);
  refusal = undefined;
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  failure = undefined;
  refusal = undefined;
  const sent = $state.snapshot(rows);
  try {
    const created = await client.libraries.create({
      name,
      medium,
      roots: sent.map((row) => row.path),
    });
    toast.success(`${created.name} added. Scanning now.`);
    await goto(`/admin/libraries/${created.id}`, { replaceState: true });
  } catch (error) {
    const refused = refusedRoot(error);
    if (refused !== undefined && refused.index < sent.length) {
      refusal = refused;
    } else {
      failure = readFailure(error);
    }
  } finally {
    busy = false;
  }
}
</script>

<AdminPage
  title="New library"
  parent={{ href: "/admin/libraries", label: "Libraries" }}
>
  <form onsubmit={submit} class="flex flex-col gap-8">
    <FormGroup>
      <FormRow label="Name" for="libraryName">
        <Input id="libraryName" name="name" required bind:value={name} />
      </FormRow>
      <FormRow label="Medium" for="libraryMedium" inline>
        <Select.Root type="single" bind:value={medium}>
          <Select.Trigger id="libraryMedium">
            <Select.Value>{mediumNames[medium]}</Select.Value>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="movies">Movies</Select.Item>
            <Select.Item value="shows">Shows</Select.Item>
          </Select.Content>
        </Select.Root>
      </FormRow>
    </FormGroup>

    <FolderFields
      {rows}
      {medium}
      refusal={refusal ?? undefined}
      onadd={addFolder}
      onrepoint={repointFolder}
      onremove={removeFolder}
      failure={failure ?? undefined}
    />

    <div class="flex justify-end">
      <Button type="submit" disabled={busy}>Add library</Button>
    </div>
  </form>
</AdminPage>
