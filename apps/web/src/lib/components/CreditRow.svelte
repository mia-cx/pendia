<script lang="ts">
import { fallbackHue, type ItemDetail } from "$lib/browse.ts";
import Shelf from "$lib/components/Shelf.svelte";

const {
  credits,
}: {
  credits: ItemDetail["credits"];
} = $props();

const titleCase = (role: string) =>
  role.charAt(0).toUpperCase() + role.slice(1);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
</script>

{#if credits.length > 0}
  <Shelf title="Cast & crew" id="cast-crew" size="person">
    {#each credits as credit, index (`${credit.contributorId}-${index}`)}
      <li class="flex w-24 flex-col items-center gap-2 text-center lg:w-28">
        <span
          class="flex size-24 items-center justify-center rounded-full artwork-fallback text-title-2 font-semibold text-label lg:size-28"
          style:--fallback-hue={fallbackHue(credit.name)}
          aria-hidden="true"
        >
          {initials(credit.name)}
        </span>
        <span class="line-clamp-2 text-subheadline">{credit.name}</span>
        <span class="text-footnote text-label-secondary"
          >{credit.character ?? titleCase(credit.role)}</span
        >
      </li>
    {/each}
  </Shelf>
{/if}
