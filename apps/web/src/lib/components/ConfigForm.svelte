<script lang="ts">
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { Switch } from "$lib/components/ui/switch/index.ts";
import { Textarea } from "$lib/components/ui/textarea/index.ts";
import { readFailure } from "$lib/errors.ts";
import {
  type ConfigField,
  configControl,
  type InstalledPlugin,
  notSet,
  readPluginConfig,
} from "$lib/plugins.ts";

/** A plugin's settings as one grouped form, saving through the given callback. */
const {
  plugin,
  save,
}: {
  plugin: InstalledPlugin;
  save: (config: Record<string, unknown>) => Promise<void>;
} = $props();

function initialText(field: ConfigField, value: unknown): string {
  if (value === undefined || value === null)
    return configControl(field) === "select" && !field.required ? notSet : "";
  const control = configControl(field);
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

function label(field: ConfigField) {
  return field.title ?? field.key;
}

function optionLabel(value: string): string {
  try {
    return String(JSON.parse(value));
  } catch {
    return value;
  }
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  const config = readPluginConfig(plugin.configFields, texts, checks);
  if (typeof config === "string") {
    failure = { code: "BAD_REQUEST", message: config };
    return;
  }
  busy = true;
  failure = undefined;
  try {
    await save(config);
    toast.success("Settings saved");
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}
</script>

<FormGroup title="Settings" onsubmit={submit} {failure}>
  {#each plugin.configFields as field (field.key)}
    {@const id = `${plugin.name}-config-${field.key}`}
    {@const control = configControl(field)}
    {#if control === "checkbox"}
      <FormRow label={label(field)} for={id} hint={field.description ?? undefined} inline>
        <Switch {id} bind:checked={checks[field.key]} />
      </FormRow>
    {:else}
      <FormRow label={label(field)} for={id} hint={field.description ?? undefined}>
        {#if control === "select"}
          <Select.Root
            type="single"
            bind:value={texts[field.key]}
          >
            <Select.Trigger {id}>
              <Select.Value
                >{texts[field.key] === notSet
                  ? "Not set"
                  : optionLabel(texts[field.key] ?? "")}</Select.Value
              >
            </Select.Trigger>
            <Select.Content>
              {#if !field.required}
                <Select.Item value={notSet}>Not set</Select.Item>
              {/if}
              {#each field.options ?? [] as option (JSON.stringify(option))}
                <Select.Item value={JSON.stringify(option)}
                  >{String(option)}</Select.Item
                >
              {/each}
            </Select.Content>
          </Select.Root>
        {:else if control === "json"}
          <Textarea
            {id}
            rows={4}
            class="font-mono"
            required={field.required}
            bind:value={texts[field.key]}
          />
        {:else}
          <Input
            {id}
            type={control === "number" ? "number" : "text"}
            step={control === "number"
              ? field.type === "integer"
                ? 1
                : "any"
              : undefined}
            required={field.required}
            value={texts[field.key]}
            oninput={(event) =>
              (texts[field.key] = event.currentTarget.value)}
          />
        {/if}
      </FormRow>
    {/if}
  {/each}
  {#snippet actions()}
    <Button type="submit" disabled={busy}>Save</Button>
  {/snippet}
</FormGroup>
