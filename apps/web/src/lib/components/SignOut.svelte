<script lang="ts">
import { goto } from "$app/navigation";
import { signOut } from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import { readFailure } from "$lib/errors.ts";

let signingOut = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

async function logout() {
  signingOut = true;
  failure = undefined;
  try {
    await signOut();
    await goto("/login");
  } catch (error) {
    const read = readFailure(error);
    if (read.code === "UNAUTHORIZED") {
      await goto("/login");
    } else {
      failure = read;
    }
  } finally {
    signingOut = false;
  }
}
</script>

{#if failure}
  <Failure {failure} />
{/if}
<button type="button" onclick={logout} disabled={signingOut}>Sign out</button>
