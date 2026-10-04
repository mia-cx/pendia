<script lang="ts">
import { page } from "$app/state";
import ItemPage from "$lib/components/ItemPage.svelte";
import PlayActions from "$lib/components/PlayActions.svelte";
</script>

{#key page.params.id}
  <ItemPage id={page.params.id ?? ""}>
    {#snippet actions(detail)}
      <PlayActions {detail} />
    {/snippet}
  </ItemPage>
{/key}
