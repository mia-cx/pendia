<script lang="ts">
import { page } from "$app/state";
import LibraryEditor from "./LibraryEditor.svelte";
</script>

{#key page.params.id}
  <LibraryEditor id={page.params.id ?? ""} />
{/key}
