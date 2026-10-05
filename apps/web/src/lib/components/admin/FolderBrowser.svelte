<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import FolderIcon from "@lucide/svelte/icons/folder";
import HardDriveIcon from "@lucide/svelte/icons/hard-drive";
import InfoIcon from "@lucide/svelte/icons/info";
import TextCursorInputIcon from "@lucide/svelte/icons/text-cursor-input";
import { ORPCError } from "@orpc/client";
import { tick } from "svelte";
import { MediaQuery } from "svelte/reactivity";
import { client } from "$lib/api.ts";
import ListRow from "$lib/components/admin/ListRow.svelte";
import Failure from "$lib/components/Failure.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Dialog from "$lib/components/ui/dialog/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import * as Sheet from "$lib/components/ui/sheet/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import { type FailureCode, readFailure } from "$lib/errors.ts";
import {
  crumbs,
  describePreview,
  type FolderPreview,
  normaliseFolder,
  overlapping,
  parentFolder,
} from "$lib/folders.ts";
import { refusedRoot } from "$lib/roots.ts";

/**
 * A dialog (a bottom sheet on phones) that walks the server's folders one
 * level at a time and previews what a scan of the current folder would find.
 * `onchoose` throws to keep the browser open and show the refusal.
 */
let {
  open = $bindable(false),
  title,
  action,
  start,
  medium,
  taken,
  onchoose,
}: {
  open?: boolean;
  title: string;
  action: string;
  start: string;
  medium: "movies" | "shows";
  taken: readonly string[];
  onchoose: (path: string) => Promise<void>;
} = $props();

const desktop = new MediaQuery("min-width: 64rem");

let current = $state("/");
let listing = $state<readonly { name: string; path: string }[] | undefined>(
  undefined,
);
let listingLoading = $state(false);
let listingFailure = $state<{ code: FailureCode; message: string } | undefined>(
  undefined,
);
let loadTicket = 0;

let preview = $state<FolderPreview | undefined>(undefined);
let previewWaiting = $state(false);
let previewFailure = $state<{ code: FailureCode; message: string } | undefined>(
  undefined,
);
let previewController: AbortController | undefined;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

let typing = $state(false);
let pathDraft = $state("/");
let pathField = $state<HTMLInputElement | null>(null);
let listEl = $state<HTMLDivElement | null>(null);
let navEl = $state<HTMLElement | null>(null);
let focusNextListing = $state(false);
let busy = $state(false);
let chooseFailure = $state<string | undefined>(undefined);

const overlapped = $derived(overlapping(current, taken));
const allCrumbs = $derived(crumbs(current));
const described = $derived(
  preview === undefined ? undefined : describePreview(preview, medium),
);
const chooseDisabled = $derived(
  busy ||
    overlapped ||
    listingFailure !== undefined ||
    preview?.reason === "missing" ||
    preview?.reason === "not-a-folder",
);

let wasOpen = false;
$effect(() => {
  if (open && !wasOpen) {
    typing = false;
    chooseFailure = undefined;
    navigate(start, true);
  } else if (!open && wasOpen) {
    previewController?.abort();
    clearTimeout(previewTimer);
    previewWaiting = false;
  }
  wasOpen = open;
});

/** Moves to `folder`; `focusRow` lands keyboard users on the new list. */
function navigate(folder: string, focusRow = false) {
  current = normaliseFolder(folder);
  pathDraft = current;
  chooseFailure = undefined;
  focusNextListing ||= focusRow;
  void loadListing();
  void tick().then(() => navEl?.scrollTo({ left: navEl.scrollWidth }));
}

async function loadListing() {
  const ticket = ++loadTicket;
  listingLoading = true;
  try {
    const answer = await client.libraries.folders({ path: current });
    if (ticket !== loadTicket) return;
    listing = answer.folders;
    listingFailure = undefined;
    schedulePreview();
  } catch (error) {
    if (ticket !== loadTicket) return;
    listing = undefined;
    // Folder errors carry the helpful sentence; readFailure's generic 404 does not.
    const failure = readFailure(error);
    listingFailure =
      error instanceof ORPCError
        ? { code: failure.code, message: error.message }
        : failure;
    // The list names the problem; the preview region stays empty.
    previewController?.abort();
    clearTimeout(previewTimer);
    preview = undefined;
    previewFailure = undefined;
    previewWaiting = false;
  } finally {
    if (ticket === loadTicket) {
      listingLoading = false;
      const focus = focusNextListing;
      focusNextListing = false;
      if (focus) {
        await tick();
        listEl?.querySelector("button")?.focus();
      }
    }
  }
}

/** Previews the settled folder 300 ms after the last move; every move aborts the pending walk. */
function schedulePreview() {
  previewController?.abort();
  const controller = new AbortController();
  previewController = controller;
  clearTimeout(previewTimer);
  preview = undefined;
  previewFailure = undefined;
  previewWaiting = !overlapped;
  if (overlapped) return;
  const folder = current;
  previewTimer = setTimeout(() => {
    void (async () => {
      try {
        const answer = await client.libraries.preview(
          { folder, medium, examples: 3 },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        preview = answer;
        previewWaiting = false;
      } catch (error) {
        if (controller.signal.aborted) return;
        previewWaiting = false;
        previewFailure = readFailure(error);
      }
    })();
  }, 300);
}

async function startTyping() {
  typing = true;
  pathDraft = current;
  await tick();
  pathField?.focus();
  pathField?.select();
}

function pathKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    if (pathDraft.trim() !== "") navigate(pathDraft.trim());
  } else if (event.key === "Escape") {
    // The dialog's own Escape closes; this one only leaves the field.
    event.stopPropagation();
    typing = false;
  }
}

async function choose() {
  busy = true;
  chooseFailure = undefined;
  try {
    await onchoose(current);
    open = false;
  } catch (error) {
    chooseFailure = refusedRoot(error)?.message ?? readFailure(error).message;
  } finally {
    busy = false;
  }
}
</script>

{#snippet body()}
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-2">
      {#if desktop.current}
        <Dialog.Title class="text-title-3 text-label">{title}</Dialog.Title>
      {:else}
        <Sheet.Title class="text-title-3 text-label">{title}</Sheet.Title>
      {/if}
    </div>

    <div class="flex items-center gap-1 px-4 pb-3">
      {#if typing}
        <Input
          bind:ref={pathField}
          aria-label="Folder path"
          class="h-8 flex-1"
          bind:value={pathDraft}
          onkeydown={pathKeydown}
        />
      {:else}
        <nav
          bind:this={navEl}
          aria-label="Folder path"
          class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {#each allCrumbs as crumb, index (crumb.path)}
            {#if index > 0}
              <ChevronRightIcon
                class="size-3.5 shrink-0 text-label-tertiary"
              />
            {/if}
            {@const last = index === allCrumbs.length - 1}
            {#if last}
              <span
                aria-current="location"
                class="rounded-sm px-2 py-1 text-subheadline font-semibold whitespace-nowrap text-label"
                >{crumb.name === "/" ? "/" : crumb.name}</span
              >
            {:else if crumb.name === "/"}
              <Button
                variant="ghost"
                size="sm"
                class="px-2 text-label-secondary"
                aria-label="Root folder"
                onclick={() => navigate("/", true)}
              >
                <HardDriveIcon class="size-4" />
              </Button>
            {:else}
              <Button
                variant="ghost"
                size="sm"
                class="px-2 whitespace-nowrap text-label-secondary"
                onclick={() => navigate(crumb.path, true)}>{crumb.name}</Button
              >
            {/if}
          {/each}
        </nav>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                aria-label="Go to a path"
                onclick={startTyping}
              >
                <TextCursorInputIcon />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Go to a path</Tooltip.Content>
        </Tooltip.Root>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-3">
      <div bind:this={listEl} class="rounded-lg bg-fill p-1">
        {#if listingLoading}
          {#each { length: 6 } as _, i (i)}
            <div
              class="relative flex min-h-12 items-center gap-3 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
            >
              <Skeleton class="size-5 rounded-sm" />
              <Skeleton class="h-4 w-2/5" />
            </div>
          {/each}
        {:else if listingFailure}
          <div class="px-4 py-3">
            <Failure inline failure={listingFailure} />
            <div class="mt-2">
              <Button
                variant="secondary"
                size="sm"
                onclick={() => navigate(parentFolder(current), true)}
                >Go up</Button
              >
            </div>
          </div>
        {:else}
          {#each listing ?? [] as folder (folder.path)}
            <ListRow
              title={folder.name}
              onclick={() => navigate(folder.path, true)}
            >
              {#snippet leading()}
                <FolderIcon class="size-5 text-tint" />
              {/snippet}
            </ListRow>
          {:else}
            <div class="relative min-h-12 px-4 py-2.5">
              <span class="text-subheadline text-label-secondary"
                >No folders inside</span
              >
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <div
      aria-live="polite"
      class="mt-3 min-h-24 shrink-0 border-t border-separator px-6 py-4"
    >
      {#if overlapped}
        <Failure
          inline
          failure={{
            code: "BAD_REQUEST",
            message: "This folder overlaps another folder of this library.",
          }}
        />
      {:else if chooseFailure !== undefined}
        <Failure
          inline
          failure={{ code: "BAD_REQUEST", message: chooseFailure }}
        />
      {:else if described}
        <div class="flex items-start gap-2">
          {#if preview?.reason === null}
            <CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-success" />
          {:else}
            <InfoIcon class="mt-0.5 size-4 shrink-0 text-label-secondary" />
          {/if}
          <div class="min-w-0">
            <p class="text-headline text-label">{described.headline}</p>
            {#if described.detail}
              <p class="text-footnote text-label-secondary">
                {described.detail}
              </p>
            {/if}
            {#each described.examples as example (example.title)}
              <p class="mt-1 text-subheadline text-label">{example.title}</p>
              {#if example.caption}
                <p class="text-footnote text-label-secondary">
                  {example.caption}
                </p>
              {/if}
            {/each}
          </div>
        </div>
      {:else if previewFailure}
        <Failure inline failure={previewFailure} />
      {:else if !listingFailure}
        <Skeleton class="h-5 w-32" />
        <p class="mt-1.5 text-footnote text-label-secondary">
          Looking for {medium}…
        </p>
      {/if}
    </div>

    <div class="flex shrink-0 justify-end gap-2 px-6 pb-5">
      {#if desktop.current}
        <Dialog.Close>
          {#snippet child({ props })}
            <Button {...props} variant="secondary">Cancel</Button>
          {/snippet}
        </Dialog.Close>
      {:else}
        <Sheet.Close>
          {#snippet child({ props })}
            <Button {...props} variant="secondary">Cancel</Button>
          {/snippet}
        </Sheet.Close>
      {/if}
      <Button onclick={choose} disabled={chooseDisabled}>{action}</Button>
    </div>
  </div>
{/snippet}

<Dialog.Root bind:open>
  {#if desktop.current}
    <Dialog.Content
      class="flex h-[min(40rem,calc(100dvh-2rem))] max-w-xl flex-col gap-0 overflow-hidden p-0"
    >
      {@render body()}
    </Dialog.Content>
  {:else}
    <Sheet.Content
      side="bottom"
      class="h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)] gap-0"
    >
      {@render body()}
    </Sheet.Content>
  {/if}
</Dialog.Root>
