<script lang="ts">
import BookmarkIcon from "@lucide/svelte/icons/bookmark";
import CheckIcon from "@lucide/svelte/icons/check";
import InfoIcon from "@lucide/svelte/icons/info";
import PlayIcon from "@lucide/svelte/icons/play";
import PlusIcon from "@lucide/svelte/icons/plus";
import SearchIcon from "@lucide/svelte/icons/search";
import SettingsIcon from "@lucide/svelte/icons/settings";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import type { BrowseCard } from "$lib/browse.ts";
import { artworkUrl } from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import LandscapeCard from "$lib/components/LandscapeCard.svelte";
import PosterCard from "$lib/components/PosterCard.svelte";
import Shelf from "$lib/components/Shelf.svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog/index.ts";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Dialog from "$lib/components/ui/dialog/index.ts";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import * as Popover from "$lib/components/ui/popover/index.ts";
import * as ScrollArea from "$lib/components/ui/scroll-area/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { Separator } from "$lib/components/ui/separator/index.ts";
import * as Sheet from "$lib/components/ui/sheet/index.ts";
import { Skeleton } from "$lib/components/ui/skeleton/index.ts";
import * as Slider from "$lib/components/ui/slider/index.ts";
import * as Switch from "$lib/components/ui/switch/index.ts";
import * as Table from "$lib/components/ui/table/index.ts";
import * as Tabs from "$lib/components/ui/tabs/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import { resource } from "$lib/resource.svelte.ts";

function sampleCard(overrides: Partial<BrowseCard>): BrowseCard {
  return {
    id: "card-1",
    kind: "movie",
    libraryId: "library-1",
    title: "Dune: Part Two",
    year: 2024,
    addedAt: "2026-10-01T00:00:00.000000Z",
    posterArtworkId: null,
    backdropArtworkId: null,
    logoArtworkId: null,
    thumbArtworkId: null,
    parentId: null,
    seasonNumber: null,
    episodeNumber: null,
    episodeEndNumber: null,
    show: null,
    ...overrides,
  };
}

const sampleShow = {
  id: "show-1",
  title: "Severance",
  posterArtworkId: null,
  backdropArtworkId: null,
  logoArtworkId: null,
};
const mediaCards = [
  sampleCard({}),
  sampleCard({
    id: "card-2",
    kind: "episode",
    title: "Half Loop",
    seasonNumber: 1,
    episodeNumber: 2,
    show: sampleShow,
  }),
];

const hero = resource(async () => {
  const list = await client.items.list({ kind: "movie" });
  for (const card of list.items.slice(0, 8)) {
    const item = await client.items.get({ id: card.id });
    const artwork = item.backdropArtworkId ?? item.posterArtworkId;
    if (artwork) return artworkUrl(artwork, 1280);
  }
  return null;
});

let quality = $state("");
let watched = $state(true);
let volume = $state(65);
let position = $state(84);
let tab = $state("details");

const versions = [
  { resolution: "2160p", codec: "HEVC", size: "18.4 GB", bitrate: "42.1" },
  { resolution: "1080p", codec: "H.264", size: "7.9 GB", bitrate: "19.8" },
  { resolution: "720p", codec: "H.264", size: "3.1 GB", bitrate: "8.4" },
];

const rows = Array.from(
  { length: 30 },
  (_, i) => `Dune: Part Two · extras ${i + 1}`,
);
</script>

<svelte:head>
  <title>Design system · Pendia</title>
</svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-12 pt-4 lg:pt-8">
  <h1 class="mb-5 text-large-title">Design system</h1>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Buttons</h2>
    <div class="flex flex-wrap items-center gap-3">
      <Button>Play</Button>
      <Button variant="secondary">Mark watched</Button>
      <Button variant="outline">Edit</Button>
      <Button variant="ghost">Skip</Button>
      <Button variant="tinted">Resume</Button>
      <Button variant="destructive">Delete</Button>
      <Button variant="link">View all</Button>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <Button size="sm">Small</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Add to list"><PlusIcon /></Button>
      <Button size="icon-lg" variant="secondary" aria-label="Settings"><SettingsIcon /></Button>
      <Button disabled>Loading…</Button>
    </div>
    <div
      class="relative flex h-44 items-end gap-3 overflow-hidden rounded-xl bg-elevated bg-cover bg-center p-5"
      style:background-image={hero.data ? `url(${hero.data})` : undefined}
    >
      <Button variant="glass"><PlayIcon /> Continue watching</Button>
      <Button variant="glass" size="icon" aria-label="Bookmark"><BookmarkIcon /></Button>
    </div>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Fields</h2>
    <div class="flex flex-col gap-3">
      <Input placeholder="Search titles" aria-label="Search" class="w-72" />
      <Input value="Dune: Part Two" aria-label="Title" class="w-72" />
      <Input value="not-an-email" aria-invalid="true" aria-label="Invalid field" class="w-72" />
      <Input disabled value="Server offline" aria-label="Disabled field" class="w-72" />
      <Select.Root type="single" bind:value={quality}>
        <Select.Trigger class="w-72"><Select.Value placeholder="Preferred quality" /></Select.Trigger>
        <Select.Content>
          <Select.Item value="original">Original</Select.Item>
          <Select.Item value="high">High · 12 Mbps</Select.Item>
          <Select.Item value="medium">Medium · 4 Mbps</Select.Item>
          <Select.Item value="low">Low · 1 Mbps</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Toggles</h2>
    <div class="flex flex-wrap items-center gap-3">
      <Switch.Root bind:checked={watched} aria-label="Watched" />
      <Switch.Root checked={false} aria-label="Auto-play next episode" />
      <Switch.Root checked={true} disabled aria-label="Disabled toggle" />
    </div>
    <Slider.Root type="single" bind:value={volume} min={0} max={100} step={1} class="w-64" aria-label="Volume" />
    <div class="dark scheme-dark w-96 max-w-full rounded-lg bg-black p-4">
      <Slider.Root
        variant="media"
        type="single"
        bind:value={position}
        min={0}
        max={180}
        step={1}
        aria-label="Position"
        valueText={`${position} of 180`}
      >
        {#snippet track()}
          <span class="absolute inset-y-0 bg-white/35" style="left: 10%; width: 35%"></span>
          <span class="absolute inset-y-0 bg-white/35" style="left: 60%; width: 15%"></span>
        {/snippet}
      </Slider.Root>
    </div>
    <Tabs.Root bind:value={tab} class="w-full max-w-md">
      <Tabs.List>
        <Tabs.Trigger value="details">Details</Tabs.Trigger>
        <Tabs.Trigger value="versions">Versions</Tabs.Trigger>
        <Tabs.Trigger value="extras">Extras</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="details" class="text-label-secondary">Directed by Denis Villeneuve.</Tabs.Content>
      <Tabs.Content value="versions" class="text-label-secondary">Three versions on disk.</Tabs.Content>
      <Tabs.Content value="extras" class="text-label-secondary">Behind-the-scenes features.</Tabs.Content>
    </Tabs.Root>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Badges</h2>
    <div class="flex flex-wrap items-center gap-3">
      <Badge>New</Badge>
      <Badge variant="tint">4K</Badge>
      <Badge variant="outline">Unmatched</Badge>
      <Badge variant="destructive">Failed</Badge>
    </div>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Menus and overlays</h2>
    <div class="flex flex-wrap items-center gap-3">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="secondary"><SearchIcon /> Actions</Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Label>Films · Dune</DropdownMenu.Label>
          <DropdownMenu.Item><PlayIcon /> Play</DropdownMenu.Item>
          <DropdownMenu.Item><BookmarkIcon /> Save for later</DropdownMenu.Item>
          <DropdownMenu.Item><CheckIcon /> Mark watched</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item class="text-destructive"><Trash2Icon class="text-destructive" /> Remove from library</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <Popover.Root>
        <Popover.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="secondary">Filter</Button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content class="w-64">
          <p class="text-subheadline text-label">Refine results</p>
          <p class="text-footnote text-label-secondary">Narrow by year, genre or quality.</p>
        </Popover.Content>
      </Popover.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon" aria-label="Info"><InfoIcon /></Button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Scanned 2 hours ago</Tooltip.Content>
      </Tooltip.Root>

      <Dialog.Root>
        <Dialog.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline">Open dialog</Button>
          {/snippet}
        </Dialog.Trigger>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Edit title</Dialog.Title>
            <Dialog.Description>Change how Pendia lists this title.</Dialog.Description>
          </Dialog.Header>
          <Input value="Dune: Part Two" aria-label="Title" />
          <Dialog.Footer>
            <Dialog.Close>
              {#snippet child({ props })}
                <Button {...props} variant="ghost">Cancel</Button>
              {/snippet}
            </Dialog.Close>
            <Button>Save</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>

      <AlertDialog.Root>
        <AlertDialog.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="destructive">Delete library</Button>
          {/snippet}
        </AlertDialog.Trigger>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Delete library?</AlertDialog.Title>
            <AlertDialog.Description>
              Deleting Films removes its titles from Pendia. The files stay on disk.
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action>Delete library</AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      <Sheet.Root>
        <Sheet.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="secondary">Right sheet</Button>
          {/snippet}
        </Sheet.Trigger>
        <Sheet.Content side="right">
          <Sheet.Header>
            <Sheet.Title>Filters</Sheet.Title>
            <Sheet.Description>Narrow the library view.</Sheet.Description>
          </Sheet.Header>
          <div class="flex items-center gap-3 px-4 py-4">
            <Switch.Root checked={true} aria-label="Watched only" />
            <p class="text-subheadline text-label-secondary">Show watched titles only.</p>
          </div>
          <Sheet.Footer>
            <Sheet.Close>
              {#snippet child({ props })}
                <Button {...props} variant="ghost">Cancel</Button>
              {/snippet}
            </Sheet.Close>
            <Button>Apply</Button>
          </Sheet.Footer>
        </Sheet.Content>
      </Sheet.Root>

      <Sheet.Root>
        <Sheet.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="secondary">Bottom sheet</Button>
          {/snippet}
        </Sheet.Trigger>
        <Sheet.Content side="bottom">
          <Sheet.Header>
            <Sheet.Title>Choose a version</Sheet.Title>
            <Sheet.Description>Pick the copy to play.</Sheet.Description>
          </Sheet.Header>
          <div class="flex flex-col px-4">
            {#each versions as v, i (v.resolution)}
              <button
                type="button"
                class="flex min-h-11 items-center justify-between gap-3 text-start text-subheadline"
              >
                <span class="text-label">{v.resolution} {v.codec}</span>
                <span class="flex items-center gap-3">
                  <span class="text-label-secondary tabular-nums">{v.size}</span>
                  {#if i === 0}<CheckIcon class="text-tint" />{/if}
                </span>
              </button>
            {/each}
          </div>
        </Sheet.Content>
      </Sheet.Root>

      <Button variant="secondary" onclick={() => toast.success("Saved")}>Success toast</Button>
      <Button variant="secondary" onclick={() => toast.error("Couldn't save")}>Error toast</Button>
    </div>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Table</h2>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Resolution</Table.Head>
          <Table.Head>Codec</Table.Head>
          <Table.Head class="text-right">Size</Table.Head>
          <Table.Head class="text-right">Bitrate (Mbps)</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each versions as v (v.resolution)}
          <Table.Row>
            <Table.Cell>{v.resolution}</Table.Cell>
            <Table.Cell>{v.codec}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{v.size}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{v.bitrate}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Skeleton</h2>
    <div class="flex flex-wrap items-start gap-3">
      <Skeleton class="w-32 rounded-poster aspect-[2/3]" />
      <div class="flex max-w-sm grow flex-col gap-3">
        <Skeleton class="h-4 w-3/4" />
        <Skeleton class="h-4 w-1/2" />
        <Skeleton class="h-4 w-5/6" />
      </div>
    </div>
  </section>

  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Scroll area</h2>
    <ScrollArea.Root class="h-48 w-72 rounded-md border border-separator">
      <div class="p-3">
        {#each rows as row (row)}
          <p class="text-subheadline py-1">{row}</p>
        {/each}
      </div>
      <ScrollArea.Scrollbar orientation="vertical" />
    </ScrollArea.Root>
  </section>
  <section class="flex flex-col gap-4">
    <h2 class="text-title-2">Media</h2>
    <div class="flex flex-wrap items-start gap-4">
      <div class="w-36">
        <Artwork
          artworkId={null}
          title="Dune: Part Two"
          kind="movie"
          caption="2024"
          sizes="144px"
        />
      </div>
      <div class="w-36">
        <Artwork
          artworkId={null}
          title="Severance"
          kind="show"
          caption="2022"
          sizes="144px"
        />
      </div>
      <div class="w-72">
        <Artwork
          artworkId={null}
          title="Severance"
          kind="episode"
          shape="landscape"
          fallbackTitle={false}
          sizes="288px"
        />
      </div>
    </div>
    <Shelf title="Poster shelf" id="design-poster-shelf">
      {#each mediaCards as card (card.id)}
        <li>
          <PosterCard
            {card}
            progress={card.id === "card-1"
              ? { positionSeconds: 2640, durationSeconds: 6600 }
              : null}
          />
        </li>
      {/each}
    </Shelf>
    <Shelf title="Landscape shelf" id="design-landscape-shelf" size="landscape">
      {#each mediaCards as card (card.id)}
        <li>
          <LandscapeCard
            {card}
            progress={card.id === "card-2"
              ? { positionSeconds: 1350, durationSeconds: 2700 }
              : null}
            fresh={card.id === "card-1"}
          />
        </li>
      {/each}
    </Shelf>
  </section>

  <Separator class="my-2" />
</div>
