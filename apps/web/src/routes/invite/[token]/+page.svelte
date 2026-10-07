<script lang="ts">
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import TimerOffIcon from "@lucide/svelte/icons/timer-off";
import UnlinkIcon from "@lucide/svelte/icons/unlink";
import { goto } from "$app/navigation";
import {
  acceptInvite,
  accountFailure,
  type InviteStatus,
  readInviteStatus,
} from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import FocusScreen from "$lib/components/FocusScreen.svelte";
import OidcSignIn from "$lib/components/OidcSignIn.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Label } from "$lib/components/ui/label/index.ts";
import { AuthRouteError, readFailure } from "$lib/errors.ts";
import type { PageProps } from "./$types";

const { data, params }: PageProps = $props();

let username = $state("");
let displayName = $state("");
let password = $state("");
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let reread = $state<InviteStatus | undefined>(undefined);

const status = $derived(reread ?? data.status);

// The accept route answers these two with server wording meant for developers.
function acceptFailure(error: unknown) {
  const read = readFailure(error);
  if (read.code === "CONFLICT")
    return {
      ...read,
      message: "An account already uses that username or this invite's email.",
    };
  return accountFailure(read, username);
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  failure = undefined;
  try {
    await acceptInvite({
      token: params.token,
      username,
      password,
      displayName: displayName.trim() === "" ? undefined : displayName,
    });
    await goto("/");
  } catch (error) {
    try {
      if (error instanceof AuthRouteError && error.code === "INVALID_INVITE")
        reread = (await readInviteStatus(params.token)).status;
      else failure = acceptFailure(error);
    } catch (statusError) {
      failure = readFailure(statusError);
    }
    busy = false;
  }
}
</script>

<svelte:head>
  <title>Join Thalia</title>
</svelte:head>

{#if status === "live"}
  <FocusScreen title="Welcome to Thalia">
    <p class="text-center text-callout text-label-secondary">
      Create your account to start watching.
    </p>
    {#if data.oidc}
      <div class="mt-4 w-full">
        <OidcSignIn name={data.oidc.name} invite={params.token} />
      </div>
      <div class="my-5 flex w-full items-center gap-3">
        <span class="h-px flex-1 bg-separator"></span>
        <span class="text-footnote text-label-secondary">or</span>
        <span class="h-px flex-1 bg-separator"></span>
      </div>
    {/if}
    <form class="mt-4 flex w-full flex-col gap-4" onsubmit={submit}>
      <div class="flex flex-col gap-1.5">
        <Label for="username">Username</Label>
        <Input
          id="username"
          name="username"
          autocomplete="username"
          maxlength={64}
          required
          bind:value={username}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="displayName"
          >Display name<span class="ml-1 font-normal text-label-secondary"
            >Optional</span
          ></Label
        >
        <Input
          id="displayName"
          name="displayName"
          autocomplete="name"
          maxlength={128}
          bind:value={displayName}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autocomplete="new-password"
          maxlength={1024}
          required
          bind:value={password}
        />
      </div>
      {#if failure}
        <Failure {failure} inline />
      {/if}
      <Button type="submit" size="lg" class="mt-2 w-full" disabled={busy}>
        Create account
      </Button>
    </form>
  </FocusScreen>
{:else if status === "expired"}
  <FocusScreen title="This invite has expired" icon={TimerOffIcon}>
    <p class="text-center text-callout text-label-secondary">
      Ask the person who invited you for a new one.
    </p>
  </FocusScreen>
{:else if status === "accepted"}
  <FocusScreen title="This invite is already used" icon={CircleCheckIcon}>
    <p class="text-center text-callout text-label-secondary">
      It already created an account.
    </p>
    <Button href="/login" size="lg" class="mt-6 w-full">Sign in</Button>
  </FocusScreen>
{:else}
  <FocusScreen title="This invite does not exist" icon={UnlinkIcon}>
    <p class="text-center text-callout text-label-secondary">
      Check that you copied the whole link, or ask for a new invite.
    </p>
  </FocusScreen>
{/if}
