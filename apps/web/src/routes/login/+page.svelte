<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { signIn } from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import FocusScreen from "$lib/components/FocusScreen.svelte";
import OidcSignIn from "$lib/components/OidcSignIn.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Label } from "$lib/components/ui/label/index.ts";
import { readFailure } from "$lib/errors.ts";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();

let username = $state("");
let password = $state("");
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let card = $state<HTMLDivElement | undefined>(undefined);

const provider = $derived(data.oidc?.name ?? "single sign-on");

// The OIDC routes send the browser back here with a lowercased auth error code.
function oidcMessage(code: string) {
  if (code === "oidc_failed")
    return `Sign-in with ${provider} did not work. Try again, or open your invite link if you are new here.`;
  if (code === "invalid_invite")
    return "That invite is used or expired. Ask for a new one.";
  if (code === "not_found")
    return `Sign-in with ${provider} is not set up on this server.`;
  return `Sign-in with ${provider} failed on the server. Try again.`;
}

let passwordTried = $state(false);
const oidcFailure = $derived(
  data.error === null || passwordTried
    ? undefined
    : { code: "UNAUTHORIZED" as const, message: oidcMessage(data.error) },
);
const shown = $derived(failure ?? oidcFailure);

onMount(() => {
  if (!matchMedia("(pointer: fine)").matches) return;
  // SvelteKit resets focus to the page root after hydration; defer past it.
  requestAnimationFrame(() => document.getElementById("username")?.focus());
});

/** Shakes the card once, macOS login style; each failed attempt replays it. */
function shakeCard() {
  if (!card) return;
  card.addEventListener(
    "animationend",
    () => card?.removeAttribute("data-shake"),
    { once: true },
  );
  // Reduced motion skips the animation, so animationend may never fire.
  setTimeout(() => card?.removeAttribute("data-shake"), 500);
  card.removeAttribute("data-shake");
  void card.offsetWidth; // force reflow so the animation restarts
  card.setAttribute("data-shake", "");
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  passwordTried = true;
  failure = undefined;
  try {
    await signIn({ username, password });
    await goto("/");
  } catch (error) {
    failure = readFailure(error);
    busy = false;
    if (failure.code === "UNAUTHORIZED") shakeCard();
  }
}
</script>

<svelte:head>
  <title>Sign in · Pendia</title>
</svelte:head>

<FocusScreen title="Sign in to Pendia" bind:card>
  {#if data.oidc}
    <OidcSignIn name={data.oidc.name} />
    <div class="my-5 flex w-full items-center gap-3">
      <span class="h-px flex-1 bg-separator"></span>
      <span class="text-footnote text-label-secondary">or</span>
      <span class="h-px flex-1 bg-separator"></span>
    </div>
  {/if}
  <form class="flex w-full flex-col gap-4" onsubmit={submit}>
    <div class="flex flex-col gap-1.5">
      <Label for="username">Username</Label>
      <Input
        id="username"
        name="username"
        autocomplete="username"
        required
        bind:value={username}
      />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="password">Password</Label>
      <Input
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
        required
        bind:value={password}
      />
    </div>
    {#if shown}
      <Failure failure={shown} inline />
    {/if}
    <Button type="submit" size="lg" class="mt-2 w-full" disabled={busy}>
      Sign in
    </Button>
  </form>
</FocusScreen>
