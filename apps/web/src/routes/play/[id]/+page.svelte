<script lang="ts">
import { page } from "$app/state";
import Player from "$lib/components/Player.svelte";

const versionId = $derived(page.url.searchParams.get("version"));
const startAt = $derived.by(() => {
  const value = Number(page.url.searchParams.get("t") ?? Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : null;
});
</script>

<!-- A new Version or start point is a new session. -->
{#key `${page.params.id}:${versionId}:${startAt}`}
  <Player id={page.params.id ?? ""} {versionId} {startAt} />
{/key}
