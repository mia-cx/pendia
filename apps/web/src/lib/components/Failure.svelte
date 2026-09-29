<script lang="ts">
import type { FailureCode } from "../errors.ts";

const { failure }: { failure: { code: FailureCode; message: string } } =
  $props();
</script>

<div class="failure" role="alert">
  <h2>
    {failure.code === "FORBIDDEN"
      ? "Permission denied"
      : "Something went wrong"}
  </h2>
  <p>{failure.message}</p>
</div>
