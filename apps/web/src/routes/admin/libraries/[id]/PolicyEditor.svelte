<script lang="ts">
import MinusIcon from "@lucide/svelte/icons/minus";
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { client } from "$lib/api.ts";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Switch } from "$lib/components/ui/switch/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import {
  deletedRungs,
  fromDraft,
  type PolicyDraft,
  type StoredPolicy,
  toDraft,
} from "$lib/stored.ts";

// The route keys this component on the id, so it never outlives its library.
const { id }: { id: string } = $props();

const policy = resource(() => client.libraries.storedVersions({ id }));

const maxRungs = 8;

let draft = $state<PolicyDraft | null>(null);
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let confirming = $state<string[] | null>(null);
let confirmOpen = $state(false);

$effect(() => {
  if (draft === null && policy.data) draft = toDraft(policy.data.policy);
});

const rungCount = $derived(
  draft === null ? 0 : draft.rungs.length + (draft.keepSource ? 1 : 0),
);

function addRung() {
  draft?.rungs.push({ name: "", height: "", bitrateMbps: "" });
}

function removeRung(index: number) {
  draft?.rungs.splice(index, 1);
}

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (draft === null || !policy.data) return;
  const deleted = deletedRungs(policy.data.policy, fromDraft(draft));
  if (deleted.length > 0) {
    confirming = deleted;
    confirmOpen = true;
    return;
  }
  void save();
}

async function save() {
  if (draft === null) return;
  confirming = null;
  busy = true;
  failure = undefined;
  const next: StoredPolicy = fromDraft(draft);
  try {
    const answer = await client.libraries.setStoredVersions({
      id,
      policy: next,
    });
    policy.set(answer);
    draft = toDraft(answer.policy);
    toast.success("Stored versions saved", {
      action: {
        label: "Show in Activity",
        onClick: () => goto("/admin/activity"),
      },
    });
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}
</script>

{#if draft !== null}
  <!-- Number fields keep their text: bind:value would hand the draft numbers. -->
  <form onsubmit={submit} class="flex flex-col gap-8">
    <FormGroup title="Stored versions">
      <FormRow label="Store the source, remuxed" for="keepSource" inline>
        <Switch id="keepSource" bind:checked={draft.keepSource} />
      </FormRow>
      {#if draft.rungs.length > 0}
        <div
          class="relative hidden grid-cols-[1fr_6.5rem_7.5rem_2rem] items-end gap-2 px-4 pb-1 pt-2.5 text-footnote text-label-secondary @lg:grid"
        >
          <span>Name</span>
          <span>Height</span>
          <span>Bitrate</span>
          <span class="sr-only">Remove</span>
        </div>
        {#each draft.rungs as rung, index (index)}
          <div
            class="relative flex flex-col gap-2 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator @lg:grid @lg:grid-cols-[1fr_6.5rem_7.5rem_2rem] @lg:items-center @lg:gap-2"
          >
            <Input
              aria-label="Rung {index + 1} name"
              placeholder={rung.height === "" ? "" : `${rung.height}p`}
              maxlength={32}
              bind:value={rung.name}
            />
            <div class="flex items-center gap-2">
              <Input
                aria-label="Rung {index + 1} height in pixels"
                type="number"
                inputmode="numeric"
                required
                min="144"
                max="4320"
                step="2"
                value={rung.height}
                oninput={(event) =>
                  (rung.height = event.currentTarget.value)}
              />
              <span class="text-footnote text-label-secondary">px</span>
            </div>
            <div class="flex items-center gap-2">
              <Input
                aria-label="Rung {index + 1} bitrate in Mbit/s"
                type="number"
                inputmode="decimal"
                required
                min="0.1"
                max="200"
                step="any"
                value={rung.bitrateMbps}
                oninput={(event) =>
                  (rung.bitrateMbps = event.currentTarget.value)}
              />
              <span class="text-footnote text-label-secondary">Mbit/s</span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove rung {index + 1}"
              onclick={() => removeRung(index)}
            >
              <MinusIcon />
            </Button>
          </div>
        {/each}
      {/if}
      {#snippet actions()}
        <Button
          variant="secondary"
          onclick={addRung}
          disabled={rungCount >= maxRungs}>Add rung</Button
        >
      {/snippet}
    </FormGroup>

    <FormGroup
      title="Sources"
      description="A source is stored when it matches any field. Leave all empty to store every source."
      failure={failure ?? undefined}
    >
      <FormRow label="Minimum height" for="minHeight">
        <div class="flex items-center gap-2">
          <Input
            id="minHeight"
            type="number"
            inputmode="numeric"
            min="1"
            step="1"
            value={draft.minHeight}
            oninput={(event) => {
              if (draft) draft.minHeight = event.currentTarget.value;
            }}
          />
          <span class="text-footnote text-label-secondary">px</span>
        </div>
      </FormRow>
      <FormRow label="Video codecs" for="codecs">
        <Input id="codecs" placeholder="hevc, av1" bind:value={draft.codecs} />
      </FormRow>
      <FormRow label="HDR" for="hdr" inline>
        <Switch id="hdr" bind:checked={draft.hdr} />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={busy}>Save</Button>
      {/snippet}
    </FormGroup>
  </form>

  <ConfirmDialog
    bind:open={confirmOpen}
    title="Delete the stored {confirming?.join(', ')} rung{confirming !== null &&
    confirming.length > 1
      ? 's'
      : ''}?"
    description="Every Item in this library loses these stored versions."
    action="Save and delete"
    onconfirm={save}
  />
{:else}
  <FormGroup
    title="Stored versions"
    loading={policy.data === undefined && !policy.failure ? 2 : undefined}
    failure={policy.failure ?? undefined}
  >
    {#snippet actions()}
      {#if policy.failure}
        <Button
          variant="secondary"
          onclick={() => policy.reload()}
          disabled={policy.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>
{/if}
