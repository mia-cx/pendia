<script lang="ts">
import { untrack } from "svelte";
import { readFailure } from "$lib/errors.ts";
import type { InstalledPlugin } from "$lib/plugins.ts";
import Failure from "./Failure.svelte";

const {
  plugin,
  save,
}: {
  plugin: InstalledPlugin;
  save: (config: Record<string, unknown>) => Promise<void>;
} = $props();

type Field = InstalledPlugin["configFields"][number];
type Control = "select" | "checkbox" | "number" | "text" | "json";

function controlOf(field: Field): Control {
  if (field.options !== null) return "select";
  if (field.type === "boolean") return "checkbox";
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.type === "string") return "text";
  return "json";
}

function initialText(field: Field, value: unknown): string {
  if (value === undefined || value === null) return "";
  const control = controlOf(field);
  if (control === "select") return JSON.stringify(value);
  if (control === "json") return JSON.stringify(value, null, 2);
  return String(value);
}

// The form starts from the saved config and then owns its edits.
const start = untrack(() => plugin);
let texts = $state<Record<string, string>>(
  Object.fromEntries(
    start.configFields.map((field) => [
      field.key,
      initialText(field, start.config[field.key]),
    ]),
  ),
);
let checks = $state<Record<string, boolean>>(
  Object.fromEntries(
    start.configFields.map((field) => [
      field.key,
      start.config[field.key] === true,
    ]),
  ),
);
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let saved = $state(false);

function label(field: Field) {
  return field.title ?? field.key;
}

/** Reads the form into a config, leaving out empty optional fields; a string result names a field that is not JSON. */
function readConfig(): Record<string, unknown> | string {
  const config: Record<string, unknown> = {};
  for (const field of plugin.configFields) {
    const control = controlOf(field);
    if (control === "checkbox") {
      config[field.key] = checks[field.key] ?? false;
      continue;
    }
    const raw = texts[field.key] ?? "";
    if (raw.trim() === "") continue;
    if (control === "number") config[field.key] = Number(raw);
    else if (control === "text") config[field.key] = raw;
    else {
      try {
        config[field.key] = JSON.parse(raw);
      } catch {
        return `${label(field)} is not valid JSON.`;
      }
    }
  }
  return config;
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  saved = false;
  const config = readConfig();
  if (typeof config === "string") {
    failure = { code: "BAD_REQUEST", message: config };
    return;
  }
  busy = true;
  failure = undefined;
  try {
    await save(config);
    saved = true;
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}
</script>

<form onsubmit={submit} oninput={() => (saved = false)}>
  {#if failure}
    <Failure {failure} />
  {/if}
  {#each plugin.configFields as field (field.key)}
    {@const id = `${plugin.name}-config-${field.key}`}
    {@const control = controlOf(field)}
    {#if control === "checkbox"}
      <div class="check">
        <input {id} type="checkbox" bind:checked={checks[field.key]} />
        <label for={id}>{label(field)}</label>
      </div>
    {:else}
      <label for={id}>{label(field)}</label>
      {#if control === "select"}
        <select {id} required={field.required} bind:value={texts[field.key]}>
          {#if !field.required}
            <option value="">Not set</option>
          {/if}
          {#each field.options ?? [] as option (JSON.stringify(option))}
            <option value={JSON.stringify(option)}>{String(option)}</option>
          {/each}
        </select>
      {:else if control === "json"}
        <textarea
          {id}
          rows="4"
          required={field.required}
          bind:value={texts[field.key]}
        ></textarea>
      {:else}
        <input
          {id}
          type={control}
          step={field.type === "integer" ? 1 : "any"}
          required={field.required}
          value={texts[field.key]}
          oninput={(event) => (texts[field.key] = event.currentTarget.value)}
        />
      {/if}
    {/if}
    {#if field.description}
      <p class="muted">{field.description}</p>
    {/if}
  {/each}
  <div class="row">
    <button type="submit" disabled={busy}>Save settings</button>
    <span class="muted" aria-live="polite">{saved ? "Saved." : ""}</span>
  </div>
</form>

<style>
form {
  display: grid;
  max-width: 420px;
  gap: 8px;
}

form p {
  margin: 0;
}

textarea {
  font-family: ui-monospace, monospace;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}

.check label {
  font-weight: 400;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
