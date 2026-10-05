<script lang="ts">
import * as Slider from "$lib/components/ui/slider/index.ts";
import { formatPosition } from "$lib/playback.ts";

const {
  position,
  duration,
  buffered,
  onseek,
}: {
  position: number;
  duration: number;
  buffered: readonly { start: number; end: number }[];
  /** Commits a drag: the position in seconds to seek to. */
  onseek: (seconds: number) => void;
} = $props();

let wrap = $state<HTMLDivElement>();
/** The dragged value while a drag is open; null follows playback. */
let dragging = $state<number | null>(null);
/** The time under the pointer while a mouse hovers the track. */
let hover = $state<number | null>(null);
// onValueChange also fires for programmatic and keyboard changes; only a real
// pointer drag should open the capsule.
let pointerDown = false;
/** Capsule edge distance so it never leaves the bar. */
const previewInset = 28;

const shown = $derived(dragging ?? position);
const previewTime = $derived(dragging ?? hover);

function timeAt(clientX: number) {
  const track = wrap?.querySelector("[data-slot='slider-track']");
  const rect = track?.getBoundingClientRect();
  if (!rect || rect.width === 0 || duration <= 0) return null;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return ratio * duration;
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
  hover = timeAt(event.clientX);
}

function onPointerLeave(event: PointerEvent) {
  if (event.pointerType === "mouse") hover = null;
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions: the slider inside carries the role -->
<div
  bind:this={wrap}
  class="relative flex-1"
  onpointermove={onPointerMove}
  onpointerleave={onPointerLeave}
  onpointerdown={() => (pointerDown = true)}
  onpointerup={() => (pointerDown = false)}
  onpointercancel={() => (pointerDown = false)}
  onlostpointercapture={() => (pointerDown = false)}
>
  <Slider.Root
    variant="media"
    type="single"
    value={shown}
    onValueChange={(next) => {
      if (pointerDown) dragging = next;
    }}
    onValueCommit={(next) => {
      // Bits UI commits on a document-level pointerup; releasing outside the
      // wrapper never runs our handlers, so clear the flag here too.
      pointerDown = false;
      dragging = null;
      onseek(next);
    }}
    min={0}
    max={Math.max(1, duration)}
    step={1}
    disabled={duration <= 0}
    aria-label="Position"
    valueText={`${formatPosition(shown)} of ${formatPosition(duration)}`}
  >
    {#snippet track()}
      {#if duration > 0}
        {#each buffered as range, index (index)}
          <span
            class="absolute inset-y-0 bg-white/35"
            style="left: {(range.start / duration) * 100}%; width: {((range.end - range.start) / duration) * 100}%"
          ></span>
        {/each}
      {/if}
    {/snippet}
  </Slider.Root>
  {#if previewTime !== null && duration > 0}
    <!-- The box a thumbnail joins above the time later. -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute bottom-full mb-2 flex flex-col items-center"
      style="left: clamp({previewInset}px, {(previewTime / duration) * 100}%, calc(100% - {previewInset}px)); transform: translateX(-50%)"
    >
      <span class="material-thick rounded-md px-2 py-0.5 text-footnote tabular-nums">
        {formatPosition(previewTime)}
      </span>
    </div>
  {/if}
</div>
