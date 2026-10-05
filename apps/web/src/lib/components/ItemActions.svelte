<script lang="ts">
import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
import HeartIcon from "@lucide/svelte/icons/heart";
import PlayIcon from "@lucide/svelte/icons/play";
import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
import StarIcon from "@lucide/svelte/icons/star";
import { onDestroy } from "svelte";
import { toast } from "svelte-sonner";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import { type DetailChild, episodeCode, type ItemDetail } from "$lib/browse.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.ts";
import * as Popover from "$lib/components/ui/popover/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import { followEvents } from "$lib/events.ts";
import { resource } from "$lib/resource.svelte.ts";

const {
  detail,
  reload,
}: {
  detail: ItemDetail;
  /** Reloads the page's detail resource, after a refresh job ends. */
  reload: () => void;
} = $props();

const admin = $derived(page.data.me?.admin === true);

// Resume on the Version the viewer was watching, from where the server says
// that Version picks up.
const start = resource(async () => {
  const progress = await client.playback.getProgress({ itemId: detail.id });
  const version =
    detail.versions.find(({ id }) => id === progress?.versionId) ??
    detail.versions[0];
  if (version === undefined) return null;
  if (progress === null || progress.completed)
    return { versionId: version.id, positionSeconds: 0 };
  const { positionSeconds } = await client.playback.resume({
    itemId: detail.id,
    versionId: version.id,
  });
  return { versionId: version.id, positionSeconds };
});

const href = (versionId: string, from?: number) =>
  `/play/${detail.id}?version=${versionId}${from === undefined ? "" : `&t=${from}`}`;

// A failed read still offers Play; the player reports what went wrong.
const fallback = $derived(
  start.failure && detail.versions[0]
    ? { versionId: detail.versions[0].id, positionSeconds: 0 }
    : undefined,
);
const choice = $derived(start.data ?? fallback);

// A Season's children are its Episodes; the first unfinished one is up next.
// A Show's Seasons hold no play target until Phase B picks the Episode.
const upNext = $derived.by<DetailChild | undefined>(() => {
  if (detail.kind !== "season") return undefined;
  return (
    detail.children.find(
      (child) => child.progress !== null && !child.progress.completed,
    ) ?? detail.children.find((child) => child.kind === "episode")
  );
});

const marks = resource(() => client.marks.get({ itemId: detail.id }));
let favourite = $state<boolean | undefined>(undefined);
let rating = $state<number | null | undefined>(undefined);
const favoured = $derived(favourite ?? marks.data?.favourite ?? false);
const current = $derived(
  rating === undefined ? (marks.data?.rating ?? 0) : (rating ?? 0),
);
const stars = $derived(Math.round(current / 2));
const rated = $derived(stars > 0);

async function toggleFavourite() {
  const next = !favoured;
  favourite = next;
  try {
    await client.marks.setFavourite({ itemId: detail.id, favourite: next });
  } catch {
    favourite = !next;
    toast.error("Couldn't update favourites");
  }
}

let hovered = $state(0);
let ratingOpen = $state(false);
const preview = $derived(hovered > 0 ? hovered : stars);

async function pick(n: number) {
  rating = n * 2;
  ratingOpen = false;
  try {
    await client.marks.setRating({ itemId: detail.id, rating: n * 2 });
  } catch {
    rating = undefined;
    toast.error("Couldn't save the rating");
  }
}

async function clearRating() {
  rating = null;
  ratingOpen = false;
  try {
    await client.marks.setRating({ itemId: detail.id, rating: null });
  } catch {
    rating = undefined;
    toast.error("Couldn't clear the rating");
  }
}

function moveStars(event: KeyboardEvent) {
  const step =
    event.key === "ArrowRight" || event.key === "ArrowUp"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowDown"
        ? -1
        : 0;
  if (step === 0) return;
  event.preventDefault();
  const next = Math.min(5, Math.max(1, preview + step));
  hovered = next;
  const star = document.querySelector<HTMLElement>(`[data-star="${next}"]`);
  star?.focus();
}

let refreshAbort: AbortController | undefined;

async function refreshMetadata() {
  try {
    const { jobId } = await client.items.refresh({ id: detail.id });
    toast.success("Refreshing metadata");
    refreshAbort?.abort();
    refreshAbort = new AbortController();
    const controller = refreshAbort;
    void followEvents(
      (signal) => client.events.stream(undefined, { signal }),
      (event) => {
        if (event.kind !== "job.progress" || event.jobId !== jobId) return;
        if (event.state !== "completed" && event.state !== "failed") return;
        controller.abort();
        if (event.state === "completed") reload();
        else toast.error("Couldn't refresh metadata");
      },
      controller.signal,
    );
  } catch {
    toast.error("Couldn't refresh metadata");
  }
}

onDestroy(() => refreshAbort?.abort());
</script>

<div class="flex min-h-11 items-center gap-3">
  {#if detail.kind === "movie" || detail.kind === "episode"}
    {#if choice}
      {#if choice.positionSeconds > 0}
        <Button size="pill" href={href(choice.versionId)}>
          <PlayIcon fill="currentColor" />
          Resume
        </Button>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="glass"
                size="icon-lg"
                class="size-11"
                href={href(choice.versionId, 0)}
                aria-label="Play from start"
              >
                <RotateCcwIcon />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Play from start</Tooltip.Content>
        </Tooltip.Root>
      {:else}
        <Button size="pill" href={href(choice.versionId)}>
          <PlayIcon fill="currentColor" />
          Play
        </Button>
      {/if}
    {/if}
  {:else if upNext !== undefined}
    <Button size="pill" href="/play/{upNext.id}">
      <PlayIcon fill="currentColor" />
      {upNext.progress === null || upNext.progress.completed
        ? `Play ${episodeCode(upNext) ?? ""}`
        : `Resume ${episodeCode(upNext) ?? ""}`}
    </Button>
  {/if}

  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="glass"
          size="icon-lg"
          class="size-11"
          onclick={toggleFavourite}
          aria-label="Favourite"
          aria-pressed={favoured}
        >
          <HeartIcon fill={favoured ? "currentColor" : "none"} />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content
      >{favoured ? "Remove from favourites" : "Add to favourites"}</Tooltip.Content
    >
  </Tooltip.Root>

  <Popover.Root bind:open={ratingOpen}>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="glass"
          size="icon-lg"
          class="size-11 {rated ? 'text-tint' : ''}"
          aria-label={rated ? `Rated ${stars} of 5` : "Rate"}
        >
          <StarIcon fill={rated ? "currentColor" : "none"} />
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-auto p-3">
      <div
        role="radiogroup"
        aria-label="Rating"
        tabindex="-1"
        class="flex items-center gap-1"
        onkeydown={moveStars}
      >
        {#each [1, 2, 3, 4, 5] as n (n)}
          <button
            type="button"
            role="radio"
            aria-checked={preview === n}
            aria-label="{n} {n === 1 ? 'star' : 'stars'}"
            data-star={n}
            tabindex={n === Math.max(1, preview) ? 0 : -1}
            class="rounded-xs p-0.5 text-label-secondary outline-none hover:text-label focus-visible:text-label"
            onmouseenter={() => (hovered = n)}
            onmouseleave={() => (hovered = 0)}
            onclick={() => pick(n)}
          >
            <StarIcon
              class="size-6"
              fill={n <= preview ? "currentColor" : "none"}
            />
          </button>
        {/each}
        {#if rated}
          <Button
            variant="ghost"
            size="sm"
            class="ms-2"
            onclick={clearRating}
          >
            Clear rating
          </Button>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Root>

  {#if admin}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="glass"
            size="icon-lg"
            class="size-11"
            aria-label="More actions"
          >
            <EllipsisIcon />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item onSelect={() => void refreshMetadata()}>
          Refresh metadata
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
</div>
