<script lang="ts">
import LayersIcon from "@lucide/svelte/icons/layers";
import MonitorPlayIcon from "@lucide/svelte/icons/monitor-play";
import { onDestroy } from "svelte";
import {
  clientLabel,
  clock,
  deliveryLine,
  transcodeLine,
} from "$lib/activity.ts";
import { client } from "$lib/api.ts";
import { cardLabel, itemHref, landscapeArtwork } from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import EmptyState from "$lib/components/admin/EmptyState.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Progress } from "$lib/components/ui/progress/index.ts";
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

{#snippet bar(label: string, value: number, max: number, text: string)}
  <Progress
    {value}
    {max}
    aria-label={label}
    aria-valuetext={text}
    class="flex-1"
  />
{/snippet}

<AdminPage title="Activity">
  <FormGroup
    title="Now playing"
    loading={sessions.data === undefined && !sessions.failure ? 2 : undefined}
    failure={sessions.failure ?? undefined}
  >
    {#if sessions.data && sessions.data.length === 0}
      <EmptyState icon={MonitorPlayIcon} title="Nothing playing" />
    {:else}
      <ul>
        {#each sessions.data ?? [] as session (session.id)}
          {@const href = itemHref(session.item)}
          {@const title = cardLabel(session.item)}
          {@const duration = session.version.durationSeconds}
          <li
            class="relative flex gap-4 px-4 py-3 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <div class="w-24 shrink-0 sm:w-32">
              <Artwork
                shape="landscape"
                artworkId={landscapeArtwork(session.item)}
                {title}
                sizes="8rem"
                kind={session.item.kind}
                fallbackTitle={false}
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-3">
                {#if href === null}
                  <span class="text-headline truncate">{title}</span>
                {:else}
                  <a {href} class="text-headline truncate">{title}</a>
                {/if}
                <span
                  class="shrink-0 text-footnote {session.state === 'playing'
                    ? 'text-tint'
                    : 'text-label-secondary'}"
                  >{stateNames[session.state]}</span
                >
              </div>
              <p class="text-footnote text-label-secondary">
                {session.user.displayName} · {clientLabel(session)}
              </p>
              <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge
                  variant={session.playMethod === "transcode"
                    ? "tint"
                    : "default"}>{methodNames[session.playMethod]}</Badge
                >
                <span class="text-footnote text-label-secondary"
                  >{deliveryLine(session)}</span
                >
              </div>
              {#if session.playMethod === "transcode" && session.reasons.length > 0}
                <p class="mt-1 text-footnote text-label-secondary">
                  {transcodeLine(session)}
                </p>
              {/if}
              {#if duration !== null}
                {@const position = session.positionSeconds ?? 0}
                <div class="mt-2 flex items-center gap-3">
                  {@render bar(
                    `${title} progress`,
                    position,
                    duration,
                    `${clock(position)} of ${clock(duration)}`,
                  )}
                  <span
                    class="shrink-0 min-w-28 text-right text-footnote tabular-nums text-label-secondary"
                    >{clock(position)} of {clock(duration)}</span
                  >
                </div>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </FormGroup>

  <FormGroup
    title="Store jobs"
    loading={store.data === undefined && !store.failure ? 1 : undefined}
    failure={store.failure ?? undefined}
    description={store.data &&
    store.data.queued.total > store.data.queued.next.length
      ? `${store.data.queued.total - store.data.queued.next.length} more queued`
      : undefined}
  >
    {#if store.data && store.data.running.length === 0 && store.data.queued.total === 0}
      <EmptyState icon={LayersIcon} title="No store jobs" />
    {:else}
      <ul>
        {#each store.data?.running ?? [] as job (job.jobId)}
          {@const title = cardLabel(job.item)}
          <li
            class="relative flex gap-4 px-4 py-3 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <div class="w-10 shrink-0">
              <Artwork
                artworkId={job.item.posterArtworkId}
                {title}
                sizes="2.5rem"
                kind={job.item.kind}
                fallbackTitle={false}
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-subheadline font-medium truncate"
                  >{title}</span
                >
                <span
                  class="shrink-0 text-footnote tabular-nums text-label-secondary"
                  >{Math.round(
                    (job.segmentsDone / Math.max(job.segmentsTotal, 1)) * 100,
                  )}%</span
                >
              </div>
              <p class="text-footnote text-label-secondary">
                {job.rung} · {job.segmentsDone} of {job.segmentsTotal} segments
              </p>
              <div class="mt-2 flex">
                {@render bar(
                  `${title}, ${job.rung}`,
                  job.segmentsDone,
                  Math.max(job.segmentsTotal, 1),
                  `${job.segmentsDone} of ${job.segmentsTotal} segments`,
                )}
              </div>
            </div>
          </li>
        {/each}
        {#each store.data?.queued.next ?? [] as job (job.jobId)}
          <li
            class="relative flex gap-4 px-4 py-3 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <div class="w-10 shrink-0">
              <Artwork
                artworkId={job.item.posterArtworkId}
                title={cardLabel(job.item)}
                sizes="2.5rem"
                kind={job.item.kind}
                fallbackTitle={false}
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-subheadline font-medium truncate"
                  >{cardLabel(job.item)}</span
                >
                <span class="shrink-0 text-footnote text-label-secondary"
                  >Queued</span
                >
              </div>
              <p class="text-footnote text-label-secondary">
                {job.rung} · {startLabel(job.runAfter)}
              </p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </FormGroup>
</AdminPage>
