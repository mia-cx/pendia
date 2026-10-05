<script lang="ts">
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import ScanState from "$lib/components/admin/ScanState.svelte";
import { navIcons } from "$lib/components/nav-icons.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import { resource } from "$lib/resource.svelte.ts";
import type { ScanStatus } from "$lib/scan.ts";

const list = resource(() => client.libraries.list());
type LibraryRow = NonNullable<typeof list.data>[number];

const mediumNames: Record<LibraryRow["medium"], string> = {
  movies: "Movies",
  shows: "Shows",
};

let statuses = $state<Record<string, ScanStatus | null>>({});

$effect(() => {
  const rows = list.data;
  if (!rows) return;
  void loadStatuses(rows);
});

async function loadStatuses(rows: readonly LibraryRow[]) {
  await Promise.all(
    rows.map(async (row) => {
      try {
        statuses[row.id] = await client.libraries.scanStatus({ id: row.id });
      } catch {
        statuses[row.id] = null;
      }
    }),
  );
}

const folderCount = (count: number) =>
  count === 1 ? "1 folder" : `${count} folders`;
</script>

<AdminPage title="Libraries">
  {#snippet actions()}
    <Button href="/admin/libraries/new">Add library</Button>
  {/snippet}
  <FormGroup
    loading={list.data === undefined && !list.failure ? 3 : undefined}
    failure={list.failure ?? undefined}
  >
    {#each list.data ?? [] as row (row.id)}
      {@const MediumIcon = navIcons[row.medium]}
      <ListRow
        title={row.name}
        caption="{mediumNames[row.medium]} · {folderCount(row.roots.length)}"
        href="/admin/libraries/{row.id}"
      >
        {#snippet leading()}
          <span
            class="flex size-7 shrink-0 items-center justify-center rounded-sm bg-fill-strong"
          >
            <MediumIcon class="size-4 text-label-secondary" />
          </span>
        {/snippet}
        <ScanState status={statuses[row.id]} withTime />
      </ListRow>
    {:else}
      {#if list.data !== undefined}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No libraries yet</span
          >
        </div>
      {/if}
    {/each}
    {#snippet actions()}
      {#if list.failure}
        <Button
          variant="secondary"
          onclick={() => list.reload()}
          disabled={list.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>
</AdminPage>
