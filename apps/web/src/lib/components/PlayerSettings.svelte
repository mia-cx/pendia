<script lang="ts">
import SettingsIcon from "@lucide/svelte/icons/settings";
import { formatBytes } from "$lib/browse.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.ts";
import { audioNames, subtitleNames } from "$lib/playback.ts";
import type { createPlayer, PlayerState } from "$lib/player-state.ts";

const {
  player,
  state,
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

type Option = { value: string; label: string; detail?: string };

const subLimit = 5;

const audioList = $derived(state.tracks?.audioStreams ?? []);
const subtitleList = $derived(state.tracks?.subtitleStreams ?? []);

/** One section's options; the value the RadioGroup binds. */
type Section = {
  heading: string;
  options: Option[];
  value: string;
  current: string;
  choose: (value: string) => void;
};

const sections = $derived.by((): Section[] => {
  const list: Section[] = [];
  if (versions.length > 1)
    list.push({
      heading: "Version",
      options: versions.map((version) => ({
        value: version.id,
        label: version.label,
        detail: formatBytes(version.bytes),
      })),
      value: state.versionId,
      current:
        versions.find((version) => version.id === state.versionId)?.label ?? "",
      choose: (value) => void player.chooseVersion(value),
    });
  if (audioList.length > 1) {
    const names = audioNames(audioList);
    const current = state.tracks?.audioStreamIndex ?? null;
    list.push({
      heading: "Audio",
      options: audioList.map((stream, index) => ({
        value: String(stream.index),
        label: names[index] ?? `Audio ${index + 1}`,
      })),
      value: current === null ? "" : String(current),
      current:
        names[audioList.findIndex((stream) => stream.index === current)] ?? "",
      choose: (value) => void player.chooseAudio(Number(value)),
    });
  }
  if (subtitleList.length > 0) {
    const names = subtitleNames(subtitleList);
    const current = state.tracks?.subtitleStreamIndex ?? null;
    const options: Option[] = [
      { value: "off", label: "Off" },
      ...subtitleList.map((stream, index) => ({
        value: String(stream.index),
        label: names[index] ?? `Subtitles ${index + 1}`,
      })),
    ];
    list.push({
      heading: "Subtitles",
      options,
      value: current === null ? "off" : String(current),
      current:
        options.find((option) =>
          current === null
            ? option.value === "off"
            : option.value === String(current),
        )?.label ?? "",
      choose: (value) =>
        void player.chooseSubtitles(value === "off" ? null : Number(value)),
    });
  }
  return list;
});
</script>

{#snippet radioList(section: Section)}
  <DropdownMenu.RadioGroup
    value={section.value}
    onValueChange={section.choose}
  >
    {#each section.options as option (option.value)}
      <DropdownMenu.RadioItem
        value={option.value}
        closeOnSelect
        disabled={state.switching}
      >
        {option.label}
        {#if option.detail}
          <span class="ml-auto shrink-0 whitespace-nowrap text-footnote text-label-secondary">{option.detail}</span>
        {/if}
      </DropdownMenu.RadioItem>
    {/each}
  </DropdownMenu.RadioGroup>
{/snippet}

{#if sections.length > 0}
  <DropdownMenu.Root
    onOpenChange={(open) => player.hold("menu", open)}
  >
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="icon" aria-label="Settings" class="text-white hover:bg-white/12">
          <SettingsIcon aria-hidden="true" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="top"
      align="end"
      sideOffset={8}
      class="w-80"
      portalProps={{ to: portal }}
    >
      {#each sections as section, index (section.heading)}
        {#if index > 0}
          <DropdownMenu.Separator />
        {/if}
        {#if section.options.length > subLimit}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger disabled={state.switching}>
              {section.heading}
              <span class="ml-auto text-footnote text-label-secondary">{section.current}</span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent portalProps={{ to: portal }}>
              {@render radioList(section)}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        {:else}
          <DropdownMenu.Group>
            <DropdownMenu.GroupHeading>{section.heading}</DropdownMenu.GroupHeading>
            {@render radioList(section)}
          </DropdownMenu.Group>
        {/if}
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
