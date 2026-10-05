<script lang="ts">
import * as Select from "$lib/components/ui/select/index.ts";
import type { FailureCode } from "$lib/errors.ts";
import { readFailure } from "$lib/errors.ts";
import {
  type FilesChoice,
  type FilesOff,
  filesChoice,
  filesOffFor,
} from "$lib/plugins.ts";

/** The file access choice of one plugin or all plugins: a Select that saves on change. */
const {
  id,
  off,
  save,
  onfailure,
}: {
  id: string;
  off: FilesOff;
  save: (off: FilesOff) => Promise<void>;
  onfailure: (
    failure: { code: FailureCode; message: string } | undefined,
  ) => void;
} = $props();

let busy = $state(false);

const current = $derived(filesChoice(off));
const until = $derived(
  off?.until
    ? new Date(off.until).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "",
);
const labels: Record<Exclude<FilesChoice, "until">, string> = {
  on: "On",
  hour: "Off for an hour",
  day: "Off for a day",
  off: "Off",
};

let snapped = $state<Exclude<FilesChoice, "until"> | undefined>(undefined);
const value = $derived<FilesChoice>(snapped ?? current);

async function change(choice: string) {
  if (
    choice !== "on" &&
    choice !== "hour" &&
    choice !== "day" &&
    choice !== "off"
  )
    return;
  snapped = choice;
  busy = true;
  onfailure(undefined);
  try {
    await save(filesOffFor(choice));
    snapped = undefined;
  } catch (error) {
    onfailure(readFailure(error));
    snapped = undefined;
  } finally {
    busy = false;
  }
}
</script>

<Select.Root
  type="single"
  {value}
  onValueChange={(next) => void change(next)}
  disabled={busy}
>
  <Select.Trigger {id}>
    <Select.Value
      >{value === "until" ? `Off until ${until}` : labels[value]}</Select.Value
    >
  </Select.Trigger>
  <Select.Content>
    <Select.Item value="on">On</Select.Item>
    {#if current === "until"}
      <Select.Item value="until">Off until {until}</Select.Item>
    {/if}
    <Select.Item value="hour">Off for an hour</Select.Item>
    <Select.Item value="day">Off for a day</Select.Item>
    <Select.Item value="off">Off</Select.Item>
  </Select.Content>
</Select.Root>
