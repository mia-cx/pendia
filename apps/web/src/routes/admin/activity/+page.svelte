<script lang="ts">
import { onDestroy } from "svelte";
import { client } from "$lib/api.ts";
import { cardLabel, itemHref } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import { followEvents } from "$lib/events.ts";
import { resource } from "$lib/resource.svelte.ts";

const sessions = resource(() => client.playback.sessions());
const store = resource(() => client.store.status());
type Session = NonNullable<typeof sessions.data>[number];

// A session going stale and a store job's progress send no event, so both
// lists also reload on a timer.
const reloadMs = 10_000;

const controller = new AbortController();
const timer = setInterval(() => {
  void sessions.reload();
  void store.reload();
}, reloadMs);
onDestroy(() => {
  controller.abort();
  clearInterval(timer);
});
void followEvents(
  (signal) => client.events.stream(undefined, { signal }),
  (event) => {
    if (event.kind === "session.state") void sessions.reload();
  },
  controller.signal,
);

const stateNames: Record<Session["state"], string> = {
  queued: "Queued",
  starting: "Starting",
  playing: "Playing",
  stopped: "Stopped",
};

const methodNames: Record<Session["playMethod"], string> = {
  "direct-play": "Direct play",
  remux: "Remux",
  transcode: "Transcode",
};

function clientLabel(session: Session) {
  if (session.clientName === null) return "Unknown app";
  if (session.deviceName === null) return session.clientName;
  return `${session.clientName} on ${session.deviceName}`;
}

function deliveryLabel(session: Session) {
  const delivery = `${methodNames[session.playMethod]} · ${session.rungs.join(", ")}`;
  return session.transcoder === null
    ? delivery
    : `${delivery} · ${session.transcoder}`;
}

const startFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function startLabel(runAfter: string) {
  const at = new Date(runAfter);
  return at.getTime() <= Date.now()
    ? "Next up"
    : `Starts ${startFormat.format(at)}`;
}
</script>

<svelte:head>
  <title>Activity · Pendia admin</title>
</svelte:head>

<h2>Activity</h2>

<section aria-labelledby="sessions-heading">
  <h3 id="sessions-heading">Sessions</h3>
  {#if sessions.failure}
    <Failure failure={sessions.failure} />
  {:else if !sessions.data}
    <p class="muted">Loading.</p>
  {:else if sessions.data.length === 0}
    <p class="muted">Nothing is playing.</p>
  {:else}
    <ul class="rows">
      {#each sessions.data as session (session.id)}
        {@const href = itemHref(session.item)}
        <li>
          <div class="line">
            {#if href === null}
              <span class="title">{cardLabel(session.item)}</span>
            {:else}
              <a class="title" {href}>{cardLabel(session.item)}</a>
            {/if}
            <span class="state" data-state={session.state}
              >{stateNames[session.state]}</span
            >
          </div>
          <p class="muted">
            {session.user.displayName} · {clientLabel(session)}
          </p>
          <p class="muted">{deliveryLabel(session)}</p>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section aria-labelledby="store-heading">
  <h3 id="store-heading">Store jobs</h3>
  {#if store.failure}
    <Failure failure={store.failure} />
  {:else if !store.data}
    <p class="muted">Loading.</p>
  {:else if store.data.running.length === 0 && store.data.queued.total === 0}
    <p class="muted">No store jobs.</p>
  {:else}
    <ul class="rows">
      {#each store.data.running as job (job.jobId)}
        <li>
          <div class="line">
            <span class="title">{cardLabel(job.item)}</span>
            <span class="state" data-state="playing">{job.rung}</span>
          </div>
          <div class="progress">
            <progress
              max={Math.max(job.segmentsTotal, 1)}
              value={job.segmentsDone}
              aria-label={`${cardLabel(job.item)}, ${job.rung}`}
            ></progress>
            <span class="muted"
              >{job.segmentsDone} of {job.segmentsTotal} segments</span
            >
          </div>
        </li>
      {/each}
      {#each store.data.queued.next as job (job.jobId)}
        <li>
          <div class="line">
            <span class="title">{cardLabel(job.item)}</span>
            <span class="state">{job.rung}</span>
          </div>
          <p class="muted">{startLabel(job.runAfter)}</p>
        </li>
      {/each}
    </ul>
    {#if store.data.queued.total > store.data.queued.next.length}
      <p class="muted">
        {store.data.queued.total - store.data.queued.next.length} more queued
      </p>
    {/if}
  {/if}
</section>

<style>
section {
  max-width: 720px;
  margin-bottom: 32px;
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.rows li {
  display: grid;
  gap: 2px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}

.rows p {
  margin: 0;
}

.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}

.title {
  overflow: hidden;
  min-width: 0;
  color: var(--ink);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state {
  flex: none;
  color: var(--muted);
  font-size: 14px;
}

.state[data-state="playing"] {
  color: var(--signal);
}

.progress {
  display: flex;
  align-items: center;
  gap: 12px;
}

progress {
  flex: 1 1 auto;
  max-width: 320px;
  height: 8px;
  accent-color: var(--signal);
}
</style>
