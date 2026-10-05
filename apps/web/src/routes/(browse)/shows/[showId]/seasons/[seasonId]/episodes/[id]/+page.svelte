<script lang="ts">
import { page } from "$app/state";
import ItemPage from "$lib/components/ItemPage.svelte";
</script>

{#key page.params.id}
  <ItemPage id={page.params.id ?? ""} />
{/key}
