<script lang="ts">
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import type { FailureCode } from "../errors.ts";

const {
  failure,
  inline = false,
}: { failure: { code: FailureCode; message: string }; inline?: boolean } =
  $props();
</script>

{#if inline}
  <div role="alert" class="flex items-start gap-2">
    <CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
    <p class="text-subheadline text-destructive">{failure.message}</p>
  </div>
{:else}
  <div role="alert" class="flex gap-3 rounded-lg bg-destructive/8 px-4 py-3">
    <CircleAlertIcon class="mt-0.5 size-5 shrink-0 text-destructive" />
    <div>
      <h2 class="text-headline text-label">
        {failure.code === "FORBIDDEN"
          ? "Permission denied"
          : failure.code === "UNREACHABLE"
            ? "Server unreachable"
            : "Something went wrong"}
      </h2>
      <p class="mt-0.5 text-subheadline text-label-secondary">
        {failure.message}
      </p>
    </div>
  </div>
{/if}
