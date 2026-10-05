<script lang="ts">
import { onDestroy } from "svelte";
import { checkHealth } from "$lib/admin.ts";
import { client } from "$lib/api.ts";
import { cardLabel, itemHref } from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { followEvents } from "$lib/events.ts";
import { resource } from "$lib/resource.svelte.ts";
import { type ScanStatus, scanState } from "$lib/scan.ts";

type Session = NonNullable<
  Awaited<ReturnType<typeof client.playback.sessions>>
>[number];

const libraries = resource(() => client.libraries.list());
const sessions = resource(() => client.playback.sessions());
let scans = $state<Record<string, ScanStatus | null>>({});

let health = $state<"ready" | "no-database" | "unreachable" | undefined>(
  undefined,
);
const healthStates = {
  ready: {
    server: { label: "Online", tone: "bg-success" },
    database: { label: "Connected", tone: "bg-success" },
  },
  "no-database": {
    server: { label: "Online", tone: "bg-success" },
    database: { label: "Unavailable", tone: "bg-destructive" },
  },
  unreachable: {
    server: { label: "Unreachable", tone: "bg-destructive" },
    database: { label: "Unknown", tone: "bg-label-tertiary" },
  },
} as const;

// Event-driven lists also reload on a timer; not every change sends an event.
const reloadMs = 10_000;

async function loadHealth() {
  health = await checkHealth();
}

async function loadScans() {
  const list = libraries.data;
  if (list === undefined) return;
  const entries = await Promise.allSettled(
    list.map(async (library) =>
      client.libraries.scanStatus({ id: library.id }),
    ),
  );
  const next: Record<string, ScanStatus | null> = {};
  for (const [i, entry] of entries.entries())
    next[list[i].id] = entry.status === "fulfilled" ? entry.value : null;
  scans = next;
}

const mediumLabels = { movies: "Movies", shows: "Shows" } as const;
const scanTones = {
  active: "bg-tint",
  done: "bg-success",
  error: "bg-destructive",
  idle: "bg-label-tertiary",
} as const;

const stateLabels: Record<Session["state"], string> = {
  queued: "Queued",
  starting: "Starting",
  playing: "Playing",
  stopped: "Stopped",
};

function clientLabel(session: Session) {
  if (session.clientName === null) return "Unknown app";
  if (session.deviceName === null) return session.clientName;
  return `${session.clientName} on ${session.deviceName}`;
}

const controller = new AbortController();
void loadHealth();
void followEvents(
  (signal) => client.events.stream(undefined, { signal }),
  (event) => {
    if (event.kind === "library.changed" || event.kind === "job.progress")
      void loadScans();
    if (event.kind === "session.state") void sessions.reload();
  },
  controller.signal,
);
const timer = setInterval(() => {
  void loadHealth();
  void libraries.reload();
  void loadScans();
  void sessions.reload();
}, reloadMs);
$effect(() => {
  if (libraries.data !== undefined) void loadScans();
});
onDestroy(() => {
  controller.abort();
  clearInterval(timer);
});
</script>

<AdminPage title="Overview">
  <FormGroup title="Health" loading={health === undefined ? 2 : undefined}>
    {#if health}
      {@const state = healthStates[health]}
      <FormRow label="Server" inline>
        <span class="flex items-center gap-2">
          <span class="size-2 rounded-full {state.server.tone}"></span>
          <span class="text-subheadline text-label-secondary"
            >{state.server.label}</span
          >
        </span>
      </FormRow>
      <FormRow label="Database" inline>
        <span class="flex items-center gap-2">
          <span class="size-2 rounded-full {state.database.tone}"></span>
          <span class="text-subheadline text-label-secondary"
            >{state.database.label}</span
          >
        </span>
      </FormRow>
    {/if}
  </FormGroup>

  <FormGroup
    title="Libraries"
    loading={libraries.data === undefined && !libraries.failure ? 3 : undefined}
    failure={libraries.failure ?? undefined}
  >
    {#if libraries.data !== undefined}
      {#each libraries.data as library (library.id)}
        {@const status = scans[library.id]}
        {@const state =
          status === null
            ? { label: "Status unavailable", tone: "idle" as const }
            : scanState(status)}
        <ListRow
          title={library.name}
          caption={mediumLabels[library.medium]}
          href="/admin/libraries/{library.id}"
        >
          <span class="flex items-center gap-2">
            <span class="size-2 rounded-full {scanTones[state.tone]}"></span>
            <span class="text-footnote text-label-secondary"
              >{state.label}</span
            >
          </span>
        </ListRow>
      {:else}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No libraries yet.</span
          >
        </div>
      {/each}
    {/if}
    {#snippet actions()}
      {#if libraries.failure}
        <Button
          variant="secondary"
          onclick={() => libraries.reload()}
          disabled={libraries.loading}>Try again</Button
        >
      {:else if libraries.data?.length === 0}
        <Button variant="secondary" href="/admin/libraries"
          >Add a library</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Now playing"
    loading={sessions.data === undefined ? 1 : undefined}
    failure={sessions.failure ?? undefined}
  >
    {#each sessions.data ?? [] as session (session.id)}
      {@const href = itemHref(session.item)}
      <ListRow
        title={cardLabel(session.item)}
        caption="{session.user.displayName} · {clientLabel(session)}"
        href={href ?? undefined}
      >
        {#snippet leading()}
          <span class="block w-8 shrink-0">
            <Artwork
              artworkId={session.item.posterArtworkId}
              title={cardLabel(session.item)}
              sizes="2rem"
              kind={session.item.kind}
              fallbackTitle={false}
            />
          </span>
        {/snippet}
        <span
          class="text-subheadline {session.state === 'playing'
            ? 'text-tint'
            : 'text-label-secondary'}">{stateLabels[session.state]}</span
        >
      </ListRow>
    {:else}
      <div class="relative min-h-12 px-4 py-2.5">
        <span class="text-subheadline text-label-secondary"
          >Nothing is playing.</span
        >
      </div>
    {/each}
    {#snippet actions()}
      <Button variant="secondary" size="sm" href="/admin/activity"
        >Open Activity</Button
      >
    {/snippet}
  </FormGroup>
</AdminPage>
