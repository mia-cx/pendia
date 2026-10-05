<script lang="ts">
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import { oidcLoginUrl } from "../auth.ts";
import { Button } from "./ui/button/index.ts";

const { name, invite }: { name: string | null; invite?: string } = $props();
</script>

<!-- A server route, so the router must hand it to the browser. -->
<Button
  href={oidcLoginUrl(invite)}
  data-sveltekit-reload
  variant="secondary"
  size="lg"
  class="w-full"
>
  <KeyRoundIcon />
  Continue with {name ?? "single sign-on"}
</Button>
