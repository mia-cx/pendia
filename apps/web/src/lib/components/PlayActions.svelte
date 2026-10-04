<script lang="ts">
import { client } from "$lib/api.ts";
import type { ItemDetail } from "$lib/browse.ts";
import { formatPosition } from "$lib/playback.ts";
import { resource } from "$lib/resource.svelte.ts";

const { detail }: { detail: ItemDetail } = $props();

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
</script>

<div class="play">
  {#if choice}
    {#if choice.positionSeconds > 0}
      <a class="button primary" href={href(choice.versionId)}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1l9 5-9 5z" /></svg>
        Resume from {formatPosition(choice.positionSeconds)}
      </a>
      <a class="button" href={href(choice.versionId, 0)}>Play from start</a>
    {:else}
      <a class="button primary" href={href(choice.versionId)}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1l9 5-9 5z" /></svg>
        Play
      </a>
    {/if}
  {/if}
</div>

<style>
  /* Reserved, so the overview does not move when the buttons arrive. */
  .play {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    min-height: 44px;
  }

  .button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 18px;
    border: 1px solid color-mix(in oklch, var(--ink) 32%, transparent);
    border-radius: 6px;
    color: var(--ink);
    font-weight: 600;
    text-decoration: none;
    font-variant-numeric: tabular-nums;
  }

  .button:hover {
    border-color: var(--signal);
  }

  .primary {
    border-color: var(--signal);
    background: var(--signal);
    color: var(--canvas);
  }

  .primary:hover {
    background: color-mix(in oklch, var(--signal) 85%, var(--ink));
  }

  svg {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }
</style>
