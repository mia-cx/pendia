<script lang="ts">
import FolderIcon from "@lucide/svelte/icons/folder";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import { toast } from "svelte-sonner";
import FolderBrowser from "$lib/components/admin/FolderBrowser.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import Failure from "$lib/components/Failure.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import type { FailureCode } from "$lib/errors.ts";
import { parentFolder } from "$lib/folders.ts";
import type { RootDraft } from "$lib/roots.ts";

/**
 * The Folders panel of a library form: one row per root with Change and
 * Remove, an Add folder action and the folder browser underneath. Removing a
 * saved root confirms first; the parent only ever calls `onremove` to commit.
 */
let {
  rows,
  medium,
  refusal,
  onadd,
  onrepoint,
  onremove,
  failure,
}: {
  rows: readonly RootDraft[];
  medium: "movies" | "shows";
  refusal?: { index: number; message: string };
  onadd: (path: string) => Promise<void>;
  onrepoint: (index: number, path: string) => Promise<void>;
  onremove: (index: number) => Promise<void>;
  failure?: { code: FailureCode; message: string };
} = $props();

const ids = $props.id();

// "add" or the index being repointed; kept after close so the browser stays mounted.
let browsing = $state<"add" | number>("add");
let browserOpen = $state(false);
let removing = $state<number | null>(null);
let removeOpen = $state(false);
let copied = $state("");

// The clipboard API exists only in a secure context, so plain HTTP selects instead.
let canCopy = $state(
  typeof navigator !== "undefined" && "clipboard" in navigator,
);

async function copyId(rootId: string) {
  try {
    await navigator.clipboard.writeText(rootId);
    copied = rootId;
    toast.success("ID copied");
  } catch {
    canCopy = false;
  }
}

const addStart = $derived(
  rows.length === 0 ? "/" : parentFolder(rows[rows.length - 1].path),
);
const browser = $derived.by(() => {
  if (browsing === "add")
    return {
      title: "Add folder",
      action: "Add folder",
      start: addStart,
      taken: rows.map((row) => row.path),
      onchoose: (path: string) => onadd(path),
    };
  const index = browsing;
  return {
    title: "Change folder",
    action: "Use folder",
    start: rows[index]?.path ?? "/",
    taken: rows.filter((_, at) => at !== index).map((row) => row.path),
    onchoose: (path: string) => onrepoint(index, path),
  };
});

function browseAdd() {
  browsing = "add";
  browserOpen = true;
}

function browseChange(index: number) {
  browsing = index;
  browserOpen = true;
}

async function requestRemove(index: number) {
  if (rows[index]?.id === undefined) {
    await onremove(index);
    return;
  }
  removing = index;
  removeOpen = true;
}
</script>

<FormGroup title="Folders" {failure}>
  {#each rows as row, index (index)}
    {@const errorId = `${ids}-folder-error-${index}`}
    <div
      class="relative flex min-h-12 items-start gap-3 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
    >
      <FolderIcon class="mt-0.5 size-5 shrink-0 text-tint" />
      <div class="min-w-0 flex-1">
        <p
          id="{ids}-folder-path-{index}"
          class="break-all text-subheadline text-label"
          aria-invalid={refusal?.index === index ? "true" : undefined}
          aria-describedby={refusal?.index === index ? errorId : undefined}
        >
          {row.path}
        </p>
        {#if row.id}
          <p class="mt-0.5 flex items-center gap-2 text-footnote text-label-secondary">
            ID {row.id.slice(0, 8)}
            {#if canCopy}
              <Button
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-footnote"
                onclick={() => copyId(row.id ?? "")}
                >{copied === row.id ? "Copied" : "Copy ID"}</Button
              >
            {:else}
              <input
                aria-label="Folder {index + 1} id"
                class="min-w-0 flex-1 bg-transparent font-mono text-footnote text-label-secondary"
                readonly
                value={row.id}
                onclick={(event) => event.currentTarget.select()}
              />
            {/if}
          </p>
        {/if}
        {#if refusal?.index === index}
          <div id={errorId} class="mt-1">
            <Failure inline failure={{ code: "BAD_REQUEST", message: refusal.message }} />
          </div>
        {/if}
      </div>
      <Button
        variant="ghost"
        size="sm"
        class="shrink-0"
        aria-describedby="{ids}-folder-path-{index}"
        onclick={() => browseChange(index)}>Change</Button
      >
      {#if rows.length > 1}
        <Button
          variant="ghost"
          size="icon-sm"
          class="shrink-0 text-destructive"
          aria-label="Remove {row.path}"
          onclick={() => requestRemove(index)}
        >
          <Trash2Icon />
        </Button>
      {/if}
    </div>
  {:else}
    <div class="relative min-h-12 px-4 py-2.5">
      <span class="text-subheadline text-label-secondary">No folders yet</span>
    </div>
  {/each}
  {#snippet actions()}
    <Button variant="secondary" onclick={browseAdd}>Add folder</Button>
  {/snippet}
</FormGroup>

<FolderBrowser
  bind:open={browserOpen}
  title={browser.title}
  action={browser.action}
  start={browser.start}
  {medium}
  taken={browser.taken}
  onchoose={browser.onchoose}
/>

<ConfirmDialog
  bind:open={removeOpen}
  title="Remove this folder?"
  description="Items found only in {removing === null ? '' : rows[removing]?.path} leave this library, along with their watch history. The files stay on disk."
  action="Remove folder"
  onconfirm={async () => {
    if (removing !== null) await onremove(removing);
  }}
/>
