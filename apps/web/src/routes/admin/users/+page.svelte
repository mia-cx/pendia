<script lang="ts">
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import { createInvite } from "$lib/auth.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import SecretInput from "$lib/components/SecretInput.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import { initials } from "$lib/shell.ts";

const list = resource(() => client.users.list());
const denied = $derived(
  list.failure?.code === "FORBIDDEN" || list.failure?.code === "UNAUTHORIZED",
);

type InviteResult = Awaited<ReturnType<typeof createInvite>>;

const instant = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

let addUsername = $state("");
let addPassword = $state("");
let addDisplayName = $state("");
let addBusy = $state(false);
let addFailure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

let inviteEmail = $state("");
let inviteDays = $state("7");
let inviteBusy = $state(false);
let inviteFailure = $state<ReturnType<typeof readFailure> | undefined>(
  undefined,
);
let inviteResult = $state<InviteResult | undefined>(undefined);
let copied = $state("");

// The clipboard API exists only in a secure context, so plain HTTP selects instead.
let canCopy = $state(
  typeof navigator !== "undefined" && "clipboard" in navigator,
);

async function copyLink(link: string) {
  try {
    await navigator.clipboard.writeText(link);
    copied = link;
    toast.success("Link copied");
  } catch {
    // A denied clipboard leaves the selectable field as the way to copy.
    canCopy = false;
  }
}

async function addUser(event: SubmitEvent) {
  event.preventDefault();
  addBusy = true;
  addFailure = undefined;
  const username = addUsername;
  const password = addPassword;
  const displayName = addDisplayName;
  try {
    const created = await client.users.create({
      username,
      password,
      displayName: displayName.trim() === "" ? undefined : displayName,
    });
    if (addUsername === username) addUsername = "";
    if (addPassword === password) addPassword = "";
    if (addDisplayName === displayName) addDisplayName = "";
    toast.success(`Account created for ${created.username}`);
    await list.reload();
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}

async function sendInvite(event: SubmitEvent) {
  event.preventDefault();
  inviteBusy = true;
  inviteFailure = undefined;
  const email = inviteEmail;
  try {
    inviteResult = await createInvite({
      email,
      expiresInSeconds: Number(inviteDays) * 86_400,
    });
    if (inviteEmail === email) inviteEmail = "";
  } catch (error) {
    inviteFailure = readFailure(error);
  } finally {
    inviteBusy = false;
  }
}

const dayOptions = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];
</script>

<AdminPage title="Users">
  <FormGroup
    loading={list.data === undefined && !list.failure ? 3 : undefined}
    failure={list.failure ?? undefined}
  >
    {#each list.data ?? [] as row (row.id)}
      <ListRow
        title={row.displayName}
        caption="@{row.username}{row.email ? ` · ${row.email}` : ''}"
        href="/admin/users/{row.id}"
      >
        {#snippet leading()}
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-fill-strong text-footnote font-semibold text-label"
            >{initials(row.displayName || row.username)}</span
          >
        {/snippet}
        {#if row.disabledAt !== null}
          <Badge>Disabled</Badge>
        {/if}
      </ListRow>
    {/each}
    {#snippet actions()}
      {#if list.failure}
        <Button
          variant="secondary"
          onclick={() => list.reload()}
          disabled={list.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  {#if !denied}
    <FormGroup
      title="Invite"
      onsubmit={sendInvite}
      failure={inviteFailure}
    >
      <FormRow label="Email" for="inviteEmail">
        <Input
          id="inviteEmail"
          name="email"
          type="email"
          required
          bind:value={inviteEmail}
        />
      </FormRow>
      <FormRow label="Link expires" for="inviteDays" inline>
        <Select.Root type="single" bind:value={inviteDays}>
          <Select.Trigger id="inviteDays">
            <Select.Value
              >{dayOptions.find((o) => o.value === inviteDays)
                ?.label}</Select.Value
            >
          </Select.Trigger>
          <Select.Content>
            {#each dayOptions as option (option.value)}
              <Select.Item value={option.value}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={inviteBusy}>Create invite link</Button>
      {/snippet}
    </FormGroup>

    {#if inviteResult}
      {@const link = `${location.origin}/invite/${inviteResult.token}`}
      <FormGroup
        title="Invite link"
        description="For {inviteResult.invite.email}. Expires {instant.format(
          new Date(inviteResult.invite.expiresAt),
        )}. Copy it now, you can't view it again."
      >
        <FormRow label="Link" for="inviteLink">
          <div class="flex items-center gap-2">
            <Input
              id="inviteLink"
              readonly
              class="font-mono"
              value={link}
              onclick={(event) => event.currentTarget.select()}
            />
            {#if canCopy}
              <Button
                variant="secondary"
                onclick={() => copyLink(link)}
                >{copied === link ? "Copied" : "Copy"}</Button
              >
            {/if}
          </div>
        </FormRow>
      </FormGroup>
    {/if}

    <FormGroup
      title="New account"
      onsubmit={addUser}
      failure={addFailure}
      description="New accounts join the users group."
    >
      <FormRow label="Username" for="addUsername">
        <Input
          id="addUsername"
          name="username"
          autocomplete="off"
          required
          bind:value={addUsername}
        />
      </FormRow>
      <FormRow label="Password" for="addPassword">
        <SecretInput
          id="addPassword"
          name="password"
          autocomplete="new-password"
          required
          bind:value={addPassword}
        />
      </FormRow>
      <FormRow label="Display name" for="addDisplayName">
        <Input
          id="addDisplayName"
          name="displayName"
          placeholder="Optional"
          bind:value={addDisplayName}
        />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={addBusy}>Create account</Button>
      {/snippet}
    </FormGroup>
  {/if}
</AdminPage>
