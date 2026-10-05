<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import CircleXIcon from "@lucide/svelte/icons/circle-x";
import { onDestroy, tick } from "svelte";
import { usernameRule } from "$lib/auth.ts";
import Failure from "$lib/components/Failure.svelte";
import FocusScreen from "$lib/components/FocusScreen.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Label } from "$lib/components/ui/label/index.ts";
import { Progress } from "$lib/components/ui/progress/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { readFailure } from "$lib/errors.ts";
import { type ScanStatus, scanProgress, waitForScan } from "$lib/scan.ts";
import {
  createAdmin,
  createFirstLibrary,
  type LibraryMedium,
  startScan,
  type WizardSession,
} from "$lib/wizard.ts";

const stepTitles = ["Account", "Library", "Scan"];

let step = $state(0);
let direction = $state(1);
let heading = $state<HTMLHeadingElement | undefined>(undefined);
let session = $state<WizardSession | undefined>(undefined);
let libraryId = $state("");
let runId = $state<string | undefined>(undefined);
let status = $state<ScanStatus | undefined>(undefined);
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

let username = $state("");
let password = $state("");
let displayName = $state("");
let libraryName = $state("");
let rootPath = $state("");
let medium = $state<LibraryMedium>("movies");

const progress = $derived(scanProgress(status));

const controller = new AbortController();
onDestroy(() => controller.abort());

/** Moves to a step, animating the body in the direction of travel. */
async function goTo(next: number) {
  direction = next > step ? 1 : -1;
  step = next;
  await tick();
  heading?.focus();
}

function submitAccount(event: SubmitEvent) {
  event.preventDefault();
  failure = undefined;
  void goTo(1);
}

async function watchScan() {
  if (!session) return;
  status = await waitForScan(session.client, libraryId, {
    signal: controller.signal,
    runId,
    onStatus: (reading) => {
      status = reading;
    },
  });
}

async function submitLibrary(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  failure = undefined;
  try {
    session ??= await createAdmin({
      username,
      password,
      displayName: displayName.trim() === "" ? undefined : displayName,
    });
  } catch (error) {
    failure = readFailure(error);
    if (failure.code === "BAD_REQUEST")
      failure = { ...failure, message: usernameRule };
    busy = false;
    await goTo(0);
    return;
  }
  try {
    const library = await createFirstLibrary(session, {
      name: libraryName,
      rootPath,
      medium,
    });
    libraryId = library.id;
    await goTo(2);
    const { jobId } = await startScan(session, libraryId);
    runId = jobId;
    await watchScan();
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}

async function rescan() {
  if (!session) return;
  busy = true;
  failure = undefined;
  try {
    const { jobId } = await startScan(session, libraryId);
    runId = jobId;
    await watchScan();
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}

async function resumeWatch() {
  busy = true;
  failure = undefined;
  try {
    await watchScan();
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}

/** Follows the run that was started, or starts one when no run id came back. */
async function retryScan() {
  if (runId === undefined) {
    await rescan();
    return;
  }
  await resumeWatch();
}

const scanTitle = $derived(
  progress.state === "done"
    ? "Your library is ready"
    : progress.state === "failed"
      ? "The scan failed"
      : "Scanning your library",
);
const title = $derived(
  step === 0
    ? "Create your account"
    : step === 1
      ? "Add your first library"
      : scanTitle,
);
</script>

<svelte:head>
  <title>Set up Pendia</title>
</svelte:head>

<FocusScreen {title} bind:heading>
  {#snippet header()}
    <ol aria-label="Setup progress" class="flex items-center gap-2">
      {#each stepTitles as stepTitle, index (stepTitle)}
        {@const stepDone =
          index < step || (index === 2 && progress.state === "done")}
        <li
          class="flex items-center gap-2"
          aria-current={index === step && !stepDone ? "step" : undefined}
        >
          <span
            class="grid size-5 place-items-center rounded-full text-caption-2 {stepDone
              ? 'bg-tint-fill'
              : index === step
                ? 'bg-tint text-tint-foreground'
                : 'bg-fill text-label-secondary'}"
          >
            {#if stepDone}
              <CheckIcon class="size-3 text-tint" />
            {:else}
              {index + 1}
            {/if}
          </span>
          <span
            class="text-footnote {index === step && !stepDone
              ? 'font-semibold text-label'
              : 'text-label-secondary'}"
            >{stepTitle}{#if stepDone}<span class="sr-only">, done</span
              >{/if}</span
          >
          {#if index < stepTitles.length - 1}
            <span class="h-px w-4 bg-separator"></span>
          {/if}
        </li>
      {/each}
    </ol>
  {/snippet}

  {#key step}
    <div
      class="w-full {direction === 1 ? 'step-forward' : 'step-back'}"
    >
      {#if step === 0}
        <p class="text-center text-callout text-label-secondary">
          This account runs the server.
        </p>
        <form class="mt-6 flex w-full flex-col gap-4" onsubmit={submitAccount}>
          {#if failure?.code === "CONFLICT"}
            <p class="text-center text-subheadline text-label-secondary">
              Setup is already complete.
              <Button variant="link" href="/login" class="h-auto p-0"
                >Sign in</Button
              >
            </p>
          {:else if failure}
            <Failure {failure} inline />
          {/if}
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
              autocomplete="new-password"
              required
              bind:value={password}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="displayName"
              >Display name<span
                class="ml-1 font-normal text-label-secondary">Optional</span
              ></Label
            >
            <Input
              id="displayName"
              name="displayName"
              autocomplete="name"
              bind:value={displayName}
            />
          </div>
          <Button type="submit" size="lg" class="mt-2 w-full" disabled={busy}>
            Continue
          </Button>
        </form>
      {:else if step === 1}
        <form
          class="flex w-full flex-col gap-4"
          onsubmit={submitLibrary}
        >
          {#if failure}
            <Failure {failure} inline />
          {/if}
          <div class="flex flex-col gap-1.5">
            <Label for="libraryName">Name</Label>
            <Input
              id="libraryName"
              name="libraryName"
              placeholder="Movies"
              required
              bind:value={libraryName}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label id="medium-label">Type</Label>
            <Select.Root
              type="single"
              bind:value={medium}
              items={[
                { value: "movies", label: "Movies" },
                { value: "shows", label: "Shows" },
              ]}
            >
              <Select.Trigger class="w-full" aria-labelledby="medium-label"
                ><Select.Value /></Select.Trigger
              >
              <Select.Content>
                <Select.Item value="movies" label="Movies">Movies</Select.Item>
                <Select.Item value="shows" label="Shows">Shows</Select.Item>
              </Select.Content>
            </Select.Root>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="rootPath">Folder</Label>
            <Input
              id="rootPath"
              name="rootPath"
              placeholder="/srv/movies"
              aria-describedby="rootPath-hint"
              required
              bind:value={rootPath}
            />
            <p id="rootPath-hint" class="text-footnote text-label-secondary">
              The full path on the server.
            </p>
          </div>
          <div class="mt-2 flex w-full gap-3">
            {#if !session}
              <Button
                variant="secondary"
                size="lg"
                onclick={() => goTo(0)}
                disabled={busy}>Back</Button
              >
            {/if}
            <Button type="submit" size="lg" class="flex-1" disabled={busy}>
              Add library
            </Button>
          </div>
        </form>
      {:else}
        <p class="text-center text-callout text-label-secondary">
          {libraryName}
        </p>
        <div class="mt-4 flex h-8 w-full items-center">
          {#if progress.state === "done"}
            <span class="check-pop mx-auto">
              <CircleCheckIcon class="size-8 text-success" />
            </span>
          {:else if progress.state === "failed"}
            <span class="check-pop mx-auto">
              <CircleXIcon class="size-8 text-destructive" />
            </span>
          {:else if progress.state === "running"}
            <Progress
              value={progress.fraction}
              aria-label="Scan progress"
              class="w-full"
            />
          {:else}
            <Progress value={null} aria-label="Scan progress" class="w-full" />
          {/if}
        </div>
        <div class="mt-4 flex w-full flex-col items-center gap-4">
          {#if progress.state === "failed"}
            <Failure
              inline
              failure={{
                code: "UNKNOWN",
                message: `${progress.failed === 1 ? "1 scan job failed." : `${progress.failed} scan jobs failed.`}${progress.error ? ` ${progress.error}` : ""}`,
              }}
            />
            <Button
              size="lg"
              class="w-full"
              onclick={rescan}
              disabled={busy}>Scan again</Button
            >
            <Button variant="ghost" href="/">Start watching</Button>
          {:else if failure}
            <Failure
              inline
              failure={{
                code: "UNKNOWN",
                message:
                  "This page stopped following the scan. The scan keeps running.",
              }}
            />
            <Button
              size="lg"
              class="w-full"
              onclick={retryScan}
              disabled={busy}>Check again</Button
            >
          {:else}
            <Button href="/" size="lg" class="w-full">Start watching</Button>
          {/if}
          <Button
            variant="link"
            href="/admin"
            class="h-auto p-0 text-footnote">Open Settings</Button
          >
        </div>
      {/if}
    </div>
  {/key}
</FocusScreen>

<style>
  /* Step bodies enter from the direction of travel: distance-base slide
     with a medium blur, after transitions-dev 08-page-side-by-side. */
  .step-forward {
    animation: step-in-forward var(--duration-fast) var(--ease-smooth-out) both;
  }
  .step-back {
    animation: step-in-back var(--duration-fast) var(--ease-smooth-out) both;
  }
  @keyframes step-in-forward {
    from {
      opacity: 0;
      transform: translateX(var(--distance-base));
      filter: blur(var(--blur-medium));
    }
    to {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @keyframes step-in-back {
    from {
      opacity: 0;
      transform: translateX(calc(var(--distance-base) * -1));
      filter: blur(var(--blur-medium));
    }
    to {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  /* The done check pops in once, after transitions-dev 10-success-check. */
  .check-pop {
    animation: check-pop var(--duration-very-slow) var(--ease-spring) both;
  }
  @keyframes check-pop {
    from {
      opacity: 0;
      transform: scale(0.5);
      filter: blur(var(--blur-large));
    }
    to {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .step-forward,
    .step-back {
      animation-name: step-fade;
    }
    .check-pop {
      animation-name: step-fade;
    }
  }
  @keyframes step-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
