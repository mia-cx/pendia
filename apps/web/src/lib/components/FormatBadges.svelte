<script lang="ts">
import { formatBadges, type ItemDetail } from "$lib/browse.ts";

const {
  versions,
}: {
  versions: ItemDetail["versions"];
} = $props();

const badges = $derived(formatBadges(versions.map((version) => version.label)));
</script>

{#each badges as badge (badge)}
  <span
    class="rounded-[4px] border border-white/40 px-1 text-caption-1 font-semibold"
    >{badge}</span
  >
{/each}
