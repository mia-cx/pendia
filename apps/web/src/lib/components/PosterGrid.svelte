<script lang="ts">
import type { Snippet } from "svelte";

const { children, ...rest }: { children: Snippet } & Record<string, unknown> =
  $props();
</script>

<ul
  {...rest}
  class="grid grid-cols-[repeat(auto-fill,minmax(min(9.5rem,28vw),1fr))] gap-x-3 gap-y-4 lg:gap-x-5 lg:gap-y-6"
>
  {@render children()}
</ul>
