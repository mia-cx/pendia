<script lang="ts">
import { page } from "$app/state";
import PolicyEditor from "./PolicyEditor.svelte";
</script>

{#key page.params.id}
  <PolicyEditor id={page.params.id ?? ""} />
{/key}
