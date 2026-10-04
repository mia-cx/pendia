<script lang="ts">
import { page } from "$app/state";
import LibraryEditor from "./LibraryEditor.svelte";
import PolicyEditor from "./PolicyEditor.svelte";
</script>

{#key page.params.id}
  <LibraryEditor id={page.params.id ?? ""} />
  <PolicyEditor id={page.params.id ?? ""} />
{/key}
