<script lang="ts">
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import { fromMbps, toMbps } from "$lib/bitrate.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import Failure from "$lib/components/Failure.svelte";
import SecretInput from "$lib/components/SecretInput.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Switch } from "$lib/components/ui/switch/index.ts";
import { Textarea } from "$lib/components/ui/textarea/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";

const settings = resource(() => client.settings.get());

type FailureShape = ReturnType<typeof readFailure>;

let proxyInput = $state<string | null>(null);
let proxyBusy = $state(false);
let proxyFailure = $state<FailureShape | undefined>(undefined);

let artChecked = $state<boolean | null>(null);
let artBusy = $state(false);
let artFailure = $state<FailureShape | undefined>(undefined);

let keyName = $state("");
let keyValue = $state("");
let keyBusy = $state(false);
let keyFailure = $state<FailureShape | undefined>(undefined);

let secretValue = $state("");
let secretBusy = $state(false);
let secretFailure = $state<FailureShape | undefined>(undefined);

let removeBusy = $state<Record<string, boolean>>({});
let removeFailures = $state<Record<string, FailureShape>>({});

let capInput = $state<string | null>(null);
let capBusy = $state(false);
let capFailure = $state<FailureShape | undefined>(undefined);

let windowStart = $state<string | null>(null);
let windowEnd = $state<string | null>(null);
let windowBusy = $state(false);
let windowFailure = $state<FailureShape | undefined>(undefined);

const proxyValue = $derived(
  proxyInput ?? (settings.data?.trustedProxyAddresses ?? []).join("\n"),
);
const capValue = $derived(
  capInput ??
    (settings.data?.bitrateCapBps == null
      ? ""
      : toMbps(settings.data.bitrateCapBps)),
);
const startValue = $derived(
  windowStart ?? settings.data?.idleWindow.start ?? "",
);
const endValue = $derived(windowEnd ?? settings.data?.idleWindow.end ?? "");

const artworkBackends = {
  colocated: "Next to the media",
  "configured-path": "A directory",
  s3: "S3",
};

let pending: Promise<unknown> = Promise.resolve();

function serial<T>(run: () => Promise<T>) {
  const next = pending.then(run, run);
  pending = next.catch(() => {});
  return next;
}

async function saveProxies(event: SubmitEvent) {
  event.preventDefault();
  proxyBusy = true;
  proxyFailure = undefined;
  try {
    const submitted = proxyValue;
    const lines = submitted
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    settings.set(
      await serial(() =>
        client.settings.update({ trustedProxyAddresses: lines }),
      ),
    );
    if (proxyInput === submitted) proxyInput = null;
    toast.success("Trusted proxies saved");
  } catch (error) {
    proxyFailure = readFailure(error);
  } finally {
    proxyBusy = false;
  }
}

async function saveCap(event: SubmitEvent) {
  event.preventDefault();
  capFailure = undefined;
  const submitted = capValue;
  const bitrateCapBps = fromMbps(submitted);
  if (bitrateCapBps === undefined) {
    capFailure = {
      code: "BAD_REQUEST",
      message: "The bitrate cap must be a positive number of Mbit/s.",
    };
    return;
  }
  capBusy = true;
  try {
    settings.set(await serial(() => client.settings.update({ bitrateCapBps })));
    if (capInput === submitted) capInput = null;
    toast.success("Bitrate cap saved");
  } catch (error) {
    capFailure = readFailure(error);
  } finally {
    capBusy = false;
  }
}

async function saveWindow(event: SubmitEvent) {
  event.preventDefault();
  windowBusy = true;
  windowFailure = undefined;
  const start = startValue;
  const end = endValue;
  try {
    settings.set(
      await serial(() =>
        client.settings.update({ idleWindow: { start, end } }),
      ),
    );
    if (windowStart === start) windowStart = null;
    if (windowEnd === end) windowEnd = null;
    toast.success("Store window saved");
  } catch (error) {
    windowFailure = readFailure(error);
  } finally {
    windowBusy = false;
  }
}

async function saveArtwork(checked: boolean) {
  artBusy = true;
  artFailure = undefined;
  try {
    settings.set(
      await serial(() =>
        client.settings.update({ artworkRequiresAuth: checked }),
      ),
    );
    artChecked = null;
    toast.success(
      checked
        ? "Artwork now requires sign-in"
        : "Artwork no longer requires sign-in",
    );
  } catch (error) {
    artChecked = null;
    artFailure = readFailure(error);
  } finally {
    artBusy = false;
  }
}

async function addKey(event: SubmitEvent) {
  event.preventDefault();
  keyBusy = true;
  keyFailure = undefined;
  const name = keyName;
  const value = keyValue;
  try {
    settings.set(
      await serial(() =>
        client.settings.setProviderKey({ name: name.trim(), value }),
      ),
    );
    if (keyName === name && keyValue === value) {
      keyName = "";
      keyValue = "";
    }
    toast.success(`${name.trim()} key saved`);
  } catch (error) {
    keyFailure = readFailure(error);
  } finally {
    keyBusy = false;
  }
}

async function saveSecret(event: SubmitEvent) {
  event.preventDefault();
  secretBusy = true;
  secretFailure = undefined;
  const oidcClientSecret = secretValue;
  try {
    settings.set(
      await serial(() => client.settings.update({ oidcClientSecret })),
    );
    if (secretValue === oidcClientSecret) secretValue = "";
    toast.success("Client secret saved");
  } catch (error) {
    secretFailure = readFailure(error);
  } finally {
    secretBusy = false;
  }
}

async function removeKey(name: string) {
  removeBusy[name] = true;
  delete removeFailures[name];
  try {
    settings.set(
      await serial(() => client.settings.deleteProviderKey({ name })),
    );
    toast.success(`${name} key removed`);
  } catch (error) {
    removeFailures[name] = readFailure(error);
  } finally {
    removeBusy[name] = false;
  }
}
</script>

<AdminPage title="General">
  {#if settings.failure}
    <Failure failure={settings.failure} />
    <div>
      <Button
        variant="secondary"
        onclick={() => settings.reload()}
        disabled={settings.loading}>Try again</Button
      >
    </div>
  {:else if !settings.data}
    <FormGroup title="Network" loading={1}>
      <span></span>
    </FormGroup>
    <FormGroup title="Playback" loading={1}>
      <span></span>
    </FormGroup>
    <FormGroup title="Store window" loading={2}>
      <span></span>
    </FormGroup>
    <FormGroup title="Artwork" loading={3}>
      <span></span>
    </FormGroup>
    <FormGroup title="Provider keys" loading={2}>
      <span></span>
    </FormGroup>
    <FormGroup title="Single sign-on" loading={3}>
      <span></span>
    </FormGroup>
  {:else}
    {@const store = settings.data.artworkStore}
    {@const secretSet = settings.data.oidcClientSecretSet}
    <FormGroup
      title="Network"
      onsubmit={saveProxies}
      failure={proxyFailure}
      description="One IP address per line. Ranges and hostnames aren't supported."
    >
      <FormRow label="Trusted proxies" for="proxyList">
        <Textarea
          id="proxyList"
          name="proxies"
          rows={4}
          class="font-mono"
          value={proxyValue}
          oninput={(event) => (proxyInput = event.currentTarget.value)}
        />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={proxyBusy}>Save</Button>
      {/snippet}
    </FormGroup>

    <FormGroup
      title="Playback"
      onsubmit={saveCap}
      failure={capFailure}
      description="Leave empty for no cap."
    >
      <FormRow label="Default bitrate cap" for="globalCap">
        <div class="flex items-center gap-3">
          <Input
            id="globalCap"
            name="bitrateCap"
            type="number"
            min="0"
            step="any"
            inputmode="decimal"
            class="w-32"
            value={capValue}
            oninput={(event) => (capInput = event.currentTarget.value)}
          />
          <span class="text-subheadline text-label-secondary">Mbit/s</span>
        </div>
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={capBusy}>Save</Button>
      {/snippet}
    </FormGroup>

    <FormGroup
      title="Store window"
      onsubmit={saveWindow}
      failure={windowFailure}
      description="Store jobs run between these times, in the server's time zone. Use the same time twice to run all day."
    >
      <FormRow label="Starts" for="windowStart">
        <Input
          id="windowStart"
          type="time"
          required
          class="w-36"
          value={startValue}
          oninput={(event) => (windowStart = event.currentTarget.value)}
        />
      </FormRow>
      <FormRow label="Ends" for="windowEnd">
        <Input
          id="windowEnd"
          type="time"
          required
          class="w-36"
          value={endValue}
          oninput={(event) => (windowEnd = event.currentTarget.value)}
        />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={windowBusy}>Save</Button>
      {/snippet}
    </FormGroup>

    <FormGroup
      title="Artwork"
      failure={artFailure}
      description="Set by THALIA_ARTWORK_STORE when Thalia starts."
    >
      <FormRow label="Require sign-in for artwork" for="artworkAuth" inline>
        <Switch
          id="artworkAuth"
          checked={artChecked ?? settings.data.artworkRequiresAuth}
          onCheckedChange={(checked) => {
            artChecked = checked;
            void saveArtwork(checked);
          }}
          disabled={artBusy}
        />
      </FormRow>
      <FormRow label="Originals" inline>
        <span class="text-subheadline text-label-secondary"
          >{artworkBackends[store.backend]}</span
        >
      </FormRow>
      {#if store.path !== null}
        <FormRow
          label={store.backend === "colocated" ? "Fallback path" : "Path"}
          inline
        >
          <span class="break-all text-subheadline text-label-secondary"
            >{store.path}</span
          >
        </FormRow>
      {/if}
      {#if store.bucket !== null}
        <FormRow label="Bucket" inline>
          <span class="break-all text-subheadline text-label-secondary"
            >{store.bucket}</span
          >
        </FormRow>
      {/if}
      {#if store.endpoint !== null}
        <FormRow label="Endpoint" inline>
          <span class="break-all text-subheadline text-label-secondary"
            >{store.endpoint}</span
          >
        </FormRow>
      {/if}
    </FormGroup>

    <FormGroup title="Provider keys">
      {#each settings.data.providerKeys as name (name)}
        <FormRow label={name} inline>
          <span class="text-subheadline text-label-secondary">
            <span aria-hidden="true">••••••••</span>
            <span class="sr-only">Hidden</span>
          </span>
          <ConfirmDialog
            title="Remove the {name} key?"
            description="Anything that uses {name} stops working until you add the key again."
            action="Remove key"
            onconfirm={() => removeKey(name)}
          >
            {#snippet trigger(props)}
              <Button
                {...props}
                variant="ghost"
                size="sm"
                class="text-destructive"
                disabled={removeBusy[name] === true}>Remove</Button
              >
            {/snippet}
          </ConfirmDialog>
          {#if Object.hasOwn(removeFailures, name)}
            <Failure failure={removeFailures[name]} />
          {/if}
        </FormRow>
      {:else}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No provider keys yet.</span
          >
        </div>
      {/each}
    </FormGroup>

    <FormGroup title="Add a key" onsubmit={addKey} failure={keyFailure}>
      <FormRow label="Name" for="keyName">
        <Input id="keyName" name="name" required bind:value={keyName} />
      </FormRow>
      <FormRow label="Value" for="keyValue">
        <SecretInput
          id="keyValue"
          name="value"
          autocomplete="off"
          required
          bind:value={keyValue}
        />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={keyBusy}>Save key</Button>
      {/snippet}
    </FormGroup>

    <FormGroup
      title="Single sign-on"
      onsubmit={saveSecret}
      failure={secretFailure}
      description="Set the issuer and client ID in the database. See apps/server/README.md."
    >
      <FormRow label="Status" inline>
        <span class="text-subheadline text-label-secondary"
          >{settings.data.oidcConfigured ? "Set up" : "Not set up"}</span
        >
      </FormRow>
      <FormRow label="Client secret" inline>
        <span class="text-subheadline text-label-secondary">
          {#if secretSet}
            <span aria-hidden="true">••••••••</span>
            <span class="sr-only">Hidden</span>
          {:else}
            Not set
          {/if}
        </span>
      </FormRow>
      <FormRow
        label={secretSet ? "New client secret" : "Client secret"}
        for="oidcSecret"
      >
        <SecretInput
          id="oidcSecret"
          name="clientSecret"
          autocomplete="off"
          required
          bind:value={secretValue}
        />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={secretBusy}
          >{secretSet ? "Replace secret" : "Save secret"}</Button
        >
      {/snippet}
    </FormGroup>
  {/if}
</AdminPage>
