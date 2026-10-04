<script lang="ts">
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import type { FailureCode } from "../errors.ts";

const { failure }: { failure: { code: FailureCode; message: string } } =
  $props();
</script>

<div
  role="alert"
  class="flex gap-3 rounded-lg bg-destructive/8 px-4 py-3"
>
  <CircleAlertIcon class="mt-0.5 size-5 shrink-0 text-destructive" />
  <div>
    <h2 class="text-headline text-label">
      {failure.code === "FORBIDDEN"
        ? "Permission denied"
        : failure.code === "UNREACHABLE"
          ? "Server unreachable"
          : "Something went wrong"}
    </h2>
    <p class="mt-0.5 text-subheadline text-label-secondary">{failure.message}</p>
  </div>
</div>
