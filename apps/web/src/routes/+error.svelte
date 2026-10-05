<script lang="ts">
import CompassIcon from "@lucide/svelte/icons/compass";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import WifiOffIcon from "@lucide/svelte/icons/wifi-off";
import { page } from "$app/state";
import FocusScreen from "$lib/components/FocusScreen.svelte";
import { Button } from "$lib/components/ui/button/index.ts";

const state = $derived(
  page.error?.code === "UNREACHABLE"
    ? "unreachable"
    : page.status === 404
      ? "not-found"
      : "generic",
);
const icon = $derived(
  state === "unreachable"
    ? WifiOffIcon
    : state === "not-found"
      ? CompassIcon
      : TriangleAlertIcon,
);
const title = $derived(
  state === "unreachable"
    ? "Server unreachable"
    : state === "not-found"
      ? "Page not found"
      : "Something went wrong",
);
const line = $derived(
  state === "unreachable"
    ? "Pendia cannot reach its server. Check your connection."
    : state === "not-found"
      ? "This page does not exist."
      : "Pendia could not load this screen.",
);
</script>

<svelte:head>
  <title>Pendia</title>
</svelte:head>

<FocusScreen {title} {icon}>
  {#if state === "not-found"}
    <p class="text-center text-callout text-label-secondary">{line}</p>
    <Button href="/" size="lg" class="mt-6 w-full">Go to Home</Button>
  {:else}
    <div role="alert" class="flex w-full flex-col items-center">
      <p class="text-center text-callout text-label-secondary">{line}</p>
    </div>
    <Button
      size="lg"
      class="mt-6 w-full"
      onclick={() => location.reload()}>Try again</Button
    >
  {/if}
</FocusScreen>
