<script lang="ts">
import { replaceState } from "$app/navigation";
import { page } from "$app/state";
import Player from "$lib/components/Player.svelte";
import type { createPlayer } from "$lib/player-state.ts";

let player = $state<ReturnType<typeof createPlayer>>();

// A Version switch updates the URL instead of remounting the player.
$effect(() => {
  const store = player?.state;
  if (store === undefined) return;
  return store.subscribe((state) => {
    if (page.url.searchParams.get("version") === state.versionId) return;
    const url = new URL(page.url);
    url.searchParams.set("version", state.versionId);
    url.searchParams.delete("t");
    replaceState(url, page.state);
  });
});
</script>

{#key page.params.id}
  <Player
    id={page.params.id ?? ""}
    versionId={page.url.searchParams.get("version")}
    startAt={(() => {
      const value = Number(page.url.searchParams.get("t") ?? Number.NaN);
      return Number.isFinite(value) && value >= 0 ? value : null;
    })()}
    bind:player
  />
{/key}
