<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import SettingsIcon from "@lucide/svelte/icons/settings";
import { tick } from "svelte";
import { formatBytes } from "$lib/browse.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.ts";
import { audioNames, subtitleNames } from "$lib/playback.ts";
import { boosts, speeds } from "$lib/player-prefs.ts";
import type { createPlayer, PlayerState } from "$lib/player-state.ts";
import {
  boostLabel,
  qualityEntries,
  qualityValue,
  speedLabel,
} from "$lib/quality.ts";

const {
  player,
  state: playerState,
  versions,
  portal,
}: {
  player: ReturnType<typeof createPlayer>;
  state: PlayerState;
  /** The Item's Versions. */
  versions: readonly { id: string; label: string; bytes: number }[];
  /** Where the menu renders so it shows in fullscreen and stays dark. */
  portal: HTMLElement | string | undefined;
} = $props();

type Option = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  /** The Version a quality option opens, when the option names one. */
  versionId?: string;
};

/** One root row and the submenu it opens in place. */
type Row = {
  key: string;
  heading: string;
  /** Shown right on the root row; ` · ` reads as `, ` in the accessible name. */
  value: string;
  options: Option[];
  current: string;
  choose: (option: Option) => void;
};

const audioList = $derived(playerState.tracks?.audioStreams ?? []);
const subtitleList = $derived(playerState.tracks?.subtitleStreams ?? []);

const rows = $derived.by((): Row[] => {
  const list: Row[] = [];
  const quality = playerState.tracks?.quality;
  list.push({
    key: "quality",
    heading: "Quality",
    value: qualityValue(playerState, quality),
    options: qualityEntries(quality, versions),
    current: playerState.quality,
    choose: (option) =>
      void player.chooseQuality(option.value, option.versionId),
  });
  if (audioList.length > 1) {
    const names = audioNames(audioList);
    const current = playerState.tracks?.audioStreamIndex ?? null;
    list.push({
      key: "audio",
      heading: "Audio",
      value:
        names[audioList.findIndex((stream) => stream.index === current)] ?? "",
      options: audioList.map((stream, index) => ({
        value: String(stream.index),
        label: names[index] ?? `Audio ${index + 1}`,
      })),
      current: current === null ? "" : String(current),
      choose: (option) => void player.chooseAudio(Number(option.value)),
    });
  }
  if (subtitleList.length > 0) {
    const names = subtitleNames(subtitleList);
    const current = playerState.tracks?.subtitleStreamIndex ?? null;
    const options: Option[] = [
      { value: "off", label: "Off" },
      ...subtitleList.map((stream, index) => ({
        value: String(stream.index),
        label: names[index] ?? `Subtitles ${index + 1}`,
      })),
    ];
    list.push({
      key: "subtitles",
      heading: "Subtitles",
      value:
        options.find((option) =>
          current === null
            ? option.value === "off"
            : option.value === String(current),
        )?.label ?? "",
      options,
      current: current === null ? "off" : String(current),
      choose: (option) =>
        void player.chooseSubtitles(
          option.value === "off" ? null : Number(option.value),
        ),
    });
  }
  list.push({
    key: "speed",
    heading: "Playback speed",
    value: speedLabel(playerState.speed),
    options: speeds.map((speed) => ({
      value: String(speed),
      label: speedLabel(speed),
    })),
    current: String(playerState.speed),
    choose: (option) => player.setSpeed(Number(option.value)),
  });
  list.push({
    key: "boost",
    heading: "Volume boost",
    value: boostLabel(playerState.boost),
    options: boosts.map((level) => ({
      value: String(level),
      label: boostLabel(level),
    })),
    current: String(playerState.boost),
    choose: (option) => player.setBoost(Number(option.value)),
  });
  if (versions.length > 1) {
    list.push({
      key: "version",
      heading: "Version",
      value:
        versions.find((version) => version.id === playerState.versionId)
          ?.label ?? "",
      options: versions.map((version) => ({
        value: version.id,
        label: version.label,
        detail: formatBytes(version.bytes),
      })),
      current: playerState.versionId,
      choose: (option) => void player.chooseVersion(option.value),
    });
  }
  return list;
});

let view = $state<string>("root");
let contentEl = $state<HTMLElement | null>(null);

const open = $derived(rows.find((row) => row.key === view));

/** Opens a row's submenu and focuses its checked option. */
async function show(key: string) {
  view = key;
  await tick();
  contentEl?.querySelector<HTMLElement>('[data-state="checked"]')?.focus();
}

/** Returns to the root list and focuses the row just left. */
async function back() {
  const left = view;
  view = "root";
  await tick();
  contentEl?.querySelector<HTMLElement>(`[data-row="${left}"]`)?.focus();
}
</script>

{#snippet submenu(row: Row)}
  <DropdownMenu.Item
    closeOnSelect={false}
    aria-label={`${row.heading}, back to settings`}
    onSelect={() => void back()}
  >
    <ChevronLeftIcon aria-hidden="true" />
    {row.heading}
  </DropdownMenu.Item>
  <DropdownMenu.Separator />
  <DropdownMenu.RadioGroup
    aria-label={row.heading}
    value={row.current}
    onValueChange={(value) => {
      const option = row.options.find((entry) => entry.value === value);
      if (option !== undefined) row.choose(option);
    }}
  >
    {#each row.options as option (option.value)}
      <DropdownMenu.RadioItem
        value={option.value}
        closeOnSelect
        disabled={option.disabled === true || playerState.switching}
      >
        <span class="shrink-0">{option.label}</span>
        {#if option.detail}
          <span class="ml-auto min-w-0 truncate text-footnote text-label-secondary">{option.detail}</span>
        {/if}
      </DropdownMenu.RadioItem>
    {/each}
  </DropdownMenu.RadioGroup>
{/snippet}

<DropdownMenu.Root
  onOpenChange={(open) => {
    player.hold("menu", open);
    if (!open) view = "root";
  }}
>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="ghost" size="icon" aria-label="Settings" class="text-white hover:bg-white/12">
        <SettingsIcon aria-hidden="true" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    bind:ref={contentEl}
    side="top"
    align="end"
    sideOffset={8}
    class="w-80"
    portalProps={{ to: portal }}
    onEscapeKeydown={(event) => {
      if (view !== "root") {
        event.preventDefault();
        void back();
      }
    }}
    onkeydown={(event) => {
      if (event.key === "ArrowLeft" && view !== "root") {
        event.preventDefault();
        event.stopPropagation();
        void back();
      }
    }}
  >
    {#if view === "root"}
      {#each rows as row (row.key)}
        <DropdownMenu.Item
          data-row={row.key}
          closeOnSelect={false}
          disabled={playerState.switching}
          aria-label={`${row.heading}, ${row.value.replaceAll(" · ", ", ")}`}
          onSelect={() => void show(row.key)}
          onkeydown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              void show(row.key);
            }
          }}
        >
          <span class="shrink-0">{row.heading}</span>
          <span class="ml-auto min-w-0 truncate text-footnote text-label-secondary">{row.value}</span>
          <ChevronRightIcon aria-hidden="true" />
        </DropdownMenu.Item>
      {/each}
    {:else if open !== undefined}
      {@render submenu(open)}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
