<script lang="ts">
import { type Snippet, tick } from "svelte";
import type { RootDraft } from "$lib/roots.ts";

// One "Folders" fieldset shared by the create and edit forms. Removing a row
// clears the refusal because the server's indexes no longer match the rows.
let {
  rows = $bindable(),
  refusal = $bindable(),
  idPrefix,
  children,
}: {
  rows: RootDraft[];
  refusal: { index: number; message: string } | undefined;
  idPrefix: string;
  children?: Snippet;
} = $props();

let inputs: HTMLInputElement[] = [];
let copied = $state("");

// The clipboard API exists only in a secure context, so plain HTTP selects instead.
let canCopy = $state(
  typeof navigator !== "undefined" && "clipboard" in navigator,
);

async function copyId(rootId: string) {
  try {
    await navigator.clipboard.writeText(rootId);
    copied = rootId;
  } catch {
    // A denied clipboard leaves the selectable field as the way to copy.
    canCopy = false;
  }
}

async function addRow() {
  rows = [...rows, { path: "" }];
  await tick();
  inputs[rows.length - 1]?.focus();
}

function removeRow(index: number) {
  rows = rows.filter((_, i) => i !== index);
  refusal = undefined;
}
</script>

<fieldset>
  <legend>Folders</legend>
  {#each rows as row, index (index)}
    <div class="folder">
      <input
        aria-label="Folder {index + 1} path"
        required
        bind:this={inputs[index]}
        bind:value={rows[index].path}
        aria-invalid={refusal?.index === index ? "true" : undefined}
        aria-describedby={refusal?.index === index
          ? `${idPrefix}FolderError${index}`
          : undefined}
        oninput={() => {
          if (refusal?.index === index) refusal = undefined;
        }}
      />
      {#if rows.length > 1}
        <button type="button" onclick={() => removeRow(index)}>Remove</button>
      {/if}
    </div>
    {#if refusal?.index === index}
      <p class="field-error" id="{idPrefix}FolderError{index}">
        {refusal.message}
      </p>
    {/if}
    {#if row.id}
      <div class="root-id">
        <label for="{idPrefix}RootId{index}">ID</label>
        <input
          id="{idPrefix}RootId{index}"
          class="mono"
          readonly
          value={row.id}
          onclick={(event) => event.currentTarget.select()}
        />
        {#if canCopy}
          <button type="button" onclick={() => copyId(row.id ?? "")}
            >{copied === row.id ? "Copied" : "Copy ID"}</button
          >
        {/if}
      </div>
    {/if}
  {/each}
  <button type="button" onclick={addRow}>Add folder</button>
  {@render children?.()}
</fieldset>

<style>
fieldset {
  display: grid;
  gap: 8px;
  justify-items: start;
  width: 100%;
}

legend {
  padding: 0;
  font-weight: 600;
}

fieldset > :global(p) {
  margin: 0;
}

.folder {
  display: flex;
  width: 100%;
  gap: 8px;
}

.folder input {
  flex: 1;
  min-width: 0;
}

.field-error {
  margin: 0;
  color: var(--danger);
}

.root-id {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  width: 100%;
  gap: 4px 8px;
}

.root-id label {
  font-weight: 400;
}

.root-id .mono {
  flex: 1;
  min-width: 0;
  font-family: monospace;
}
</style>
